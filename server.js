import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Runway-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 3000);
const PERSIST_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB = process.env.DB_FILE || path.join(PERSIST_ROOT, 'db.json');
const VIDEO_DIR = process.env.VIDEO_STORAGE_DIR || path.join(PERSIST_ROOT, 'videos');
const cfg = {
  videoProvider: (process.env.VIDEO_PROVIDER || 'auto').trim().toLowerCase(),
  openaiKey: process.env.OPENAI_API_KEY || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  openaiBase: (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
  geminiBase: (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
  adminEmail: (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'CHANGE_THIS_STRONG_PASSWORD',
  runwayKey: process.env.RUNWAYML_API_SECRET || '',
  runwayBase: (process.env.RUNWAY_API_BASE || 'https://api.dev.runwayml.com/v1').replace(/\/$/, ''),
  freeUrl: (process.env.FREE_ENGINE_URL || 'https://multimodalart-minimax-h3.hf.space').replace(/\/$/, ''),
  freeKey: process.env.FREE_ENGINE_API_KEY || '',
  zMerchant: process.env.ZARINPAL_MERCHANT_ID || '',
  zCallback: process.env.ZARINPAL_CALLBACK_URL || '',
  zBase: (process.env.ZARINPAL_API_BASE || 'https://api.zarinpal.com/pg/v4/payment').replace(/\/$/, ''),
  price: Number(process.env.PRICE_PER_VIDEO || 10000),
  userFree: Number(process.env.DAILY_FREE_USER || 5),
  adminFree: Number(process.env.DAILY_FREE_ADMIN || 80),
  currency: process.env.CURRENCY || 'IRT',
  defaultVideoModel: (process.env.VIDEO_MODEL || 'auto').trim().toLowerCase()
};

function getIndexFilePath() {
  for (const p of [path.join(__dirname,'index.html'), path.join(__dirname,'public','index.html'), path.join(process.cwd(),'index.html'), path.join(process.cwd(),'public','index.html')]) if (fs.existsSync(p)) return p;
  return null;
}
function ensure(){ fs.mkdirSync(path.dirname(DB),{recursive:true}); fs.mkdirSync(VIDEO_DIR,{recursive:true}); if(!fs.existsSync(DB)) fs.writeFileSync(DB,JSON.stringify({users:[],payments:[],jobs:[],projects:[],settings:{bankName:'',accountHolder:'',cardNumber:'',iban:'',bankNote:''}},null,2)); }
function db(){ ensure(); let d; try{d=JSON.parse(fs.readFileSync(DB,'utf8'))}catch{d={users:[],payments:[],jobs:[],settings:{}}} d.users??=[];d.payments??=[];d.jobs??=[];d.projects??=[];d.settings??={};return d; }
function save(d){ fs.writeFileSync(DB,JSON.stringify(d,null,2)); }
function hash(p,s=crypto.randomBytes(16).toString('hex')){return `${s}:${crypto.scryptSync(p,s,64).toString('hex')}`;}
function check(p,h){try{const [s,x]=String(h).split(':');if(!s||!x)return false;const a=Buffer.from(x,'hex'),b=crypto.scryptSync(p,s,64);return a.length===b.length&&crypto.timingSafeEqual(a,b)}catch{return false}}
function uid(){return crypto.randomBytes(12).toString('hex')}
function token(id){return Buffer.from(`${id}.${Date.now()}.${crypto.randomBytes(24).toString('hex')}`).toString('base64url')}
const sessions=new Map();
const activeJobs=new Map();
function auth(req,res,next){const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const s=sessions.get(t);if(!s)return res.status(401).json({error:'نیاز به ورود دارید.'});const d=db(),u=d.users.find(x=>x.id===s.id);if(!u)return res.status(401).json({error:'کاربر یافت نشد.'});req.user=u;req.db=d;req.token=t;next()}
function admin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'دسترسی فقط برای Admin مجاز است.'});next()}
function day(){return new Date().toISOString().slice(0,10)}
function usage(d,u){const ds=day();const n=d.jobs.filter(j=>j.userId===u.id&&j.day===ds&&['PROCESSING','SUCCEEDED'].includes(j.status)).length;return{date:ds,used:n,limit:u.role==='admin'?cfg.adminFree:cfg.userFree,unlimited:u.role==='admin'}}
function publicUser(d,u){return{id:u.id,email:u.email,role:u.role,wallet:Number(u.wallet||0),usage:usage(d,u)}}
function chargeFor(u,d){const q=usage(d,u);if(q.unlimited||q.used<q.limit)return 0;return cfg.price}
async function callJson(url,body,headers={}){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});let x={};try{x=await r.json()}catch{}if(!r.ok)throw Error(x?.error?.message||x?.errors?.message||x?.error||`HTTP ${r.status}`);return x}
function normalizeVideoModel(model){const m=String(model||cfg.defaultVideoModel||'auto').trim().toLowerCase();return ['auto','veo-fast','veo-pro','minimax-h3'].includes(m)?m:'auto'}
function chooseVideoProvider(hasImage,model='auto',duration=6){
  const m=normalizeVideoModel(model);
  if(m==='minimax-h3')return 'free';
  if(m==='veo-fast'||m==='veo-pro')return cfg.geminiKey?'gemini':null;
  if(cfg.videoProvider==='free') return 'free';
  if(cfg.geminiKey) return 'gemini';
  return null;
}
function providerDuration(provider,duration){
  const n=Math.max(4,Number(duration)||6);
  if(provider==='gemini') return n>8?8:n;
  return Math.min(15,n);
}
function dataUriToBlob(dataUri){
  const m=String(dataUri||'').match(/^data:([^;]+);base64,(.+)$/s);
  if(!m) return null;
  return new Blob([Buffer.from(m[2],'base64')],{type:m[1]});
}
async function submitOpenAISora(prompt,duration,ratio,promptImage,model='sora-2'){
  const seconds=providerDuration('openai',duration);
  const selectedModel=model==='sora-2-pro'?'sora-2-pro':'sora-2';
  const size=ratio==='720:1280'?'720x1280':ratio==='960:960'?'720x1280':'1280x720';
  const form=new FormData();
  form.append('model',selectedModel);
  form.append('prompt',prompt);
  form.append('seconds',String(seconds));
  form.append('size',size);
  const img=dataUriToBlob(promptImage);
  if(img) form.append('input_reference',img,'reference.png');
  const rr=await fetch(cfg.openaiBase+'/videos',{method:'POST',headers:{Authorization:'Bearer '+cfg.openaiKey},body:form,signal:AbortSignal.timeout(60000)});
  const body=await rr.json().catch(()=>({}));
  if(!rr.ok||!body.id) throw Error(body?.error?.message||'OpenAI Sora خطا داد.');
  return {provider:'openai',externalId:body.id,duration:seconds};
}
async function submitGeminiVeo(prompt,duration,ratio,promptImage,model='veo-fast',resolution='720p',seed=null){
  let seconds=providerDuration('gemini',duration);
  if(promptImage)seconds=8;
  const selectedModel=model==='veo-pro'?'veo-3.1-generate-preview':(process.env.GEMINI_VIDEO_MODEL||'veo-3.1-fast-generate-preview');
  const instance={prompt};
  if(promptImage){
    const m=String(promptImage).match(/^data:([^;]+);base64,(.+)$/s);
    if(m) instance.image={bytesBase64Encoded:m[2],mimeType:m[1]};
  }
  let selectedResolution=['720p','1080p','4k'].includes(resolution)?resolution:(process.env.GEMINI_VIDEO_RESOLUTION||'720p');
  if(seconds!==8&&selectedResolution!=='720p')selectedResolution='720p';
  const parameters={aspectRatio:ratio==='720:1280'?'9:16':'16:9',durationSeconds:String(seconds),resolution:selectedResolution};
  if(Number.isInteger(Number(seed))&&Number(seed)>=0)parameters.seed=Number(seed);
  const rr=await fetch(cfg.geminiBase+'/models/'+encodeURIComponent(selectedModel)+':predictLongRunning?key='+encodeURIComponent(cfg.geminiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instances:[instance],parameters}),signal:AbortSignal.timeout(60000)});
  const body=await rr.json().catch(()=>({}));
  if(!rr.ok||!body.name) throw Error(body?.error?.message||'Gemini Veo خطا داد.');
  return {provider:'gemini',externalId:body.name,duration:seconds};
}
async function refreshOpenAISora(job){
  const rr=await fetch(cfg.openaiBase+'/videos/'+encodeURIComponent(job.externalId),{headers:{Authorization:'Bearer '+cfg.openaiKey},signal:AbortSignal.timeout(30000)});
  const r=await rr.json().catch(()=>({}));
  if(!rr.ok) throw Error(r?.error?.message||'OpenAI وضعیت Job را برنگرداند.');
  job.status=r.status==='completed'?'SUCCEEDED':r.status==='failed'?'FAILED':'PROCESSING';
  job.progress=Number(r.progress||0);
  if(r.error?.message) job.error=r.error.message;
  if(job.status==='PROCESSING') { job.pollFailures=0; job.lastPollError=null; }
  return job;
}
async function submitGeminiExtension(job, videoUri){
  const rrVideo=await fetch(videoUri,{headers:{'x-goog-api-key':cfg.geminiKey},signal:AbortSignal.timeout(180000)});
  if(!rrVideo.ok)throw Error('Gemini ویدئوی پایه برای Extension را برنگرداند.');
  const videoBytes=Buffer.from(await rrVideo.arrayBuffer()).toString('base64');
  const extensionPrompt=job.extensionPrompt||'Continue the scene seamlessly. Preserve the same characters, environment, camera style, lighting, wardrobe, motion and visual continuity. Continue the action naturally from the final moment.';
  const model=job.model==='veo-pro'?'veo-3.1-generate-preview':'veo-3.1-fast-generate-preview';
  const rr=await fetch(cfg.geminiBase+'/models/'+encodeURIComponent(model)+':predictLongRunning?key='+encodeURIComponent(cfg.geminiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instances:[{prompt:extensionPrompt,video:{inlineData:{mimeType:'video/mp4',data:videoBytes}}}],parameters:{numberOfVideos:1,resolution:'720p'}}),signal:AbortSignal.timeout(60000)});
  const body=await rr.json().catch(()=>({}));
  if(!rr.ok||!body.name)throw Error(body?.error?.message||'Gemini Video Extension خطا داد.');
  return body.name;
}
async function refreshGeminiVeo(job){
  if(!job?.externalId) throw Error('Gemini operation شناسه ندارد.');
  const op=String(job.externalId);
  const opPath=op.replace(/^https?:\/\/[^/]+\//,'').replace(/^\/+/, '');
  const url=opPath.startsWith('v1beta/') ? cfg.geminiBase+'/'+opPath.slice(7) : cfg.geminiBase+'/'+opPath;
  const rr=await fetch(url,{headers:{'x-goog-api-key':cfg.geminiKey},signal:AbortSignal.timeout(30000)});
  const raw=await rr.text();
  let r={};try{r=raw?JSON.parse(raw):{}}catch{throw Error('Gemini پاسخ JSON معتبر برنگرداند.')}
  if(!rr.ok) throw Error(r?.error?.message||r?.error?.status||('Gemini status HTTP '+rr.status));
  if(r.done===true){
    if(r.error){job.status='FAILED';job.error=r.error.message||JSON.stringify(r.error);return job}
    const v=r.response?.generateVideoResponse?.generatedSamples?.[0]?.video
      ||r.response?.generateVideoResponse?.generatedVideos?.[0]?.video
      ||r.response?.generatedVideos?.[0]?.video;
    if(!v?.uri) throw Error('Gemini عملیات تمام شد اما URI ویدئو در پاسخ وجود ندارد.');
    if(job.requestedDuration>8 && !job.extensionSubmitted){
      job.extensionPrompt='Continue the scene seamlessly from the final moment. Preserve the same characters, environment, historical details, camera movement, lighting, wardrobe, colors and physical motion. Do not introduce modern objects or visual discontinuities.';
      job.stage='EXTENDING';
      job.extensionSubmitted=true;
      job.extensionCount=1;
      job.externalId=await submitGeminiExtension(job,v.uri);
      job.duration=15;
      job.status='PROCESSING';
      job.progress=50;
      job.pollFailures=0;
      job.lastPollError=null;
      return job;
    }
    job.providerVideoUrl=v.uri;
    job.status='SUCCEEDED';
    job.progress=100;
    job.pollFailures=0;
    job.lastPollError=null;
    job.finishedAt=Date.now();
  }else{
    job.status='PROCESSING';
    if(typeof r.metadata?.progressPercent==='number') job.progress=Math.max(0,Math.min(99,Math.round(r.metadata.progressPercent)));
    if(typeof r.metadata?.state==='string') job.stage=r.metadata.state;
    job.pollFailures=0;
    job.lastPollError=null;
  }
  return job;
}
function isMp4Buffer(buf){
  if(!Buffer.isBuffer(buf)||buf.length<16)return false;
  const p=buf.subarray(0,64).toString('latin1');
  return p.includes('ftyp');
}
async function cacheMp4(job,buf){const file=path.join(VIDEO_DIR,job.taskId+'.mp4');await fs.promises.writeFile(file,buf);job.localOutputPath=file;job.outputBytes=buf.length;job.completedAt=Date.now();return file}
function sendMp4(res,buf,source){
  if(!isMp4Buffer(buf)) throw Error('Provider خروجی معتبر MP4 برنگرداند.');
  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Content-Length',String(buf.length));
  res.setHeader('Content-Disposition','inline; filename="ayaz-video.mp4"');
  res.setHeader('Cache-Control','private, max-age=300');
  return res.send(buf);
}
function safePublicSettings(d){return{bankName:d.settings.bankName||'',accountHolder:d.settings.accountHolder||'',cardNumber:d.settings.cardNumber||'',iban:d.settings.iban||'',bankNote:d.settings.bankNote||''}}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'ayaz-video-maker',version:process.env.RAILWAY_GIT_COMMIT_SHA||process.env.RENDER_GIT_COMMIT||process.env.COMMIT_SHA||'local',node:process.version,indexAvailable:Boolean(getIndexFilePath()),port:PORT,openaiConfigured:Boolean(cfg.openaiKey),geminiConfigured:Boolean(cfg.geminiKey),freeEngineConfigured:Boolean(cfg.freeUrl),videoProvider:cfg.videoProvider,defaultVideoModel:cfg.defaultVideoModel,models:{veoFast:Boolean(cfg.geminiKey),veoPro:Boolean(cfg.geminiKey),minimaxH3:Boolean(cfg.freeUrl)},minDuration:4,maxDuration:30,dailyFreeUser:cfg.userFree,dailyFreeAdmin:cfg.adminFree,pricePerVideo:cfg.price,currency:cfg.currency,zarinpalConfigured:Boolean(cfg.zMerchant&&cfg.zCallback)}));
app.post('/api/auth/register',(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!/^\S+@\S+\.\S+$/.test(email)||password.length<6)return res.status(400).json({error:'ایمیل معتبر و رمز عبور حداقل ۶ کاراکتری لازم است.'});const d=db();if(d.users.some(u=>u.email===email))return res.status(409).json({error:'این کاربر قبلاً ثبت شده است.'});const u={id:uid(),email,passwordHash:hash(password),role:'user',wallet:0,createdAt:Date.now()};d.users.push(u);save(d);const t=token(u.id);sessions.set(t,{id:u.id});res.json({token:t,user:publicUser(d,u)})});
app.post('/api/auth/login',(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const d=db();let u=d.users.find(x=>x.email===email);if(!u&&email===cfg.adminEmail){u={id:'admin',email:cfg.adminEmail,passwordHash:hash(cfg.adminPassword),role:'admin',wallet:0,createdAt:Date.now()};d.users.push(u);save(d)}if(!u||!check(password,u.passwordHash))return res.status(401).json({error:'ایمیل یا رمز عبور نادرست است.'});const t=token(u.id);sessions.set(t,{id:u.id});res.json({token:t,user:publicUser(d,u)})});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:publicUser(req.db,req.user)}));
app.post('/api/auth/logout',auth,(req,res)=>{sessions.delete(req.token);res.json({ok:true})});
app.get('/api/wallet',auth,(req,res)=>res.json({wallet:Number(req.user.wallet||0),usage:usage(req.db,req.user),pricePerVideo:cfg.price,currency:cfg.currency,bank:safePublicSettings(req.db)}));
app.get('/api/jobs',auth,(req,res)=>{const jobs=req.db.jobs.filter(x=>x.userId===req.user.id).slice(0,100).map(j=>({...j,url:j.status==='SUCCEEDED'?'/api/tasks/'+encodeURIComponent(j.taskId)+'/video?token='+encodeURIComponent(req.token):null,externalId:undefined,providerVideoUrl:undefined,localOutputPath:undefined}));res.json({jobs})});
app.delete('/api/jobs/:id',auth,(req,res)=>{const d=req.db,i=d.jobs.findIndex(x=>x.taskId===req.params.id&&x.userId===req.user.id);if(i<0)return res.status(404).json({error:'Job پیدا نشد.'});const j=d.jobs[i];if(j.status==='PROCESSING')return res.status(409).json({error:'Job در حال پردازش است و حذف نشد.'});if(j.localOutputPath)fs.promises.unlink(j.localOutputPath).catch(()=>{});d.jobs.splice(i,1);activeJobs.delete(j.taskId);save(d);res.json({ok:true})});
app.get('/api/projects',auth,(req,res)=>res.json({projects:req.db.projects.filter(x=>x.userId===req.user.id).slice(0,100)}));
app.post('/api/projects',auth,(req,res)=>{const name=String(req.body.name||'').trim();if(!name||name.length>120)return res.status(400).json({error:'نام پروژه نامعتبر است.'});const d=req.db,p={id:uid(),userId:req.user.id,name,createdAt:Date.now(),updatedAt:Date.now()};d.projects.unshift(p);save(d);res.json({project:p})});
app.delete('/api/projects/:id',auth,(req,res)=>{const d=req.db,i=d.projects.findIndex(x=>x.id===req.params.id&&x.userId===req.user.id);if(i<0)return res.status(404).json({error:'پروژه پیدا نشد.'});d.projects.splice(i,1);save(d);res.json({ok:true})});
app.get('/api/models',auth,(req,res)=>res.json({models:[{id:'auto',name:'Auto Router',provider:'router',available:Boolean(cfg.geminiKey)},{id:'veo-fast',name:'Gemini Veo 3.1 Fast',provider:'gemini',available:Boolean(cfg.geminiKey)},{id:'veo-pro',name:'Gemini Veo 3.1',provider:'gemini',available:Boolean(cfg.geminiKey)},{id:'minimax-h3',name:'MiniMax H3',provider:'free',available:Boolean(cfg.freeUrl)}]}));
app.get('/api/payments',auth,(req,res)=>res.json({payments:req.db.payments.filter(x=>x.userId===req.user.id).slice(0,100)}));
app.post('/api/payment/zarinpal/request',auth,async(req,res)=>{const amount=Math.floor(Number(req.body.amount||0));if(!Number.isFinite(amount)||amount<1000)return res.status(400).json({error:'مبلغ شارژ حداقل ۱۰۰۰ است.'});if(!cfg.zMerchant||!cfg.zCallback)return res.status(503).json({error:'زرین‌پال هنوز در تنظیمات سرور فعال نشده است.'});const d=req.db,id=uid(),p={id,userId:req.user.id,amount,currency:cfg.currency,status:'PENDING',createdAt:Date.now()};d.payments.push(p);save(d);try{const r=await callJson(`${cfg.zBase}/request.json`,{merchant_id:cfg.zMerchant,amount,callback_url:`${cfg.zCallback}${cfg.zCallback.includes('?')?'&':'?'}payment_id=${id}`,description:`شارژ کیف پول Ayaz - ${req.user.email}`,metadata:{email:req.user.email}});const authority=r?.data?.authority;if(!authority)throw Error(r?.errors?.message||'Authority دریافت نشد.');p.authority=authority;save(d);res.json({ok:true,paymentId:id,authority,url:`https://www.zarinpal.com/pg/StartPay/${authority}`})}catch(e){p.status='FAILED';p.error=e.message;save(d);res.status(502).json({error:'خطا در ایجاد پرداخت زرین‌پال: '+e.message})}});
app.get('/api/payment/zarinpal/callback',async(req,res)=>{const id=String(req.query.payment_id||''),authority=String(req.query.Authority||''),status=String(req.query.Status||'');const d=db(),p=d.payments.find(x=>x.id===id);if(!p)return res.status(404).send('تراکنش پیدا نشد.');if(p.status==='PAID')return res.send('این تراکنش قبلاً تأیید شده است.');if(status!=='OK'){p.status='CANCELED';save(d);return res.send('پرداخت لغو شد.')}try{const r=await callJson(`${cfg.zBase}/verify.json`,{merchant_id:cfg.zMerchant,authority,amount:p.amount});const code=Number(r?.data?.code);if(code===100||code===101){p.status='PAID';p.refId=r?.data?.ref_id||null;p.verifiedAt=Date.now();const u=d.users.find(x=>x.id===p.userId);if(u)u.wallet=Number(u.wallet||0)+p.amount;save(d);return res.send('پرداخت با موفقیت تأیید شد. می‌توانید به سایت برگردید.')}p.status='FAILED';p.error=r?.errors?.message||`code ${code}`;save(d);res.status(400).send('تأیید پرداخت ناموفق بود.')}catch(e){p.status='FAILED';p.error=e.message;save(d);res.status(502).send('خطا در تأیید پرداخت: '+e.message)}});
app.get('/api/admin/overview',auth,admin,(req,res)=>{const d=req.db;res.json({users:d.users.map(u=>publicUser(d,u)),payments:d.payments.slice(0,200),jobs:d.jobs.slice(0,200),settings:{dailyFreeUser:cfg.userFree,dailyFreeAdmin:cfg.adminFree,pricePerVideo:cfg.price,currency:cfg.currency,freeEngineConfigured:Boolean(cfg.freeUrl),runwayConfigured:Boolean(cfg.runwayKey),zarinpalConfigured:Boolean(cfg.zMerchant&&cfg.zCallback),bank:safePublicSettings(d)}})});
app.post('/api/admin/users/:id/credit',auth,admin,(req,res)=>{const d=req.db,u=d.users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'کاربر یافت نشد.'});const amount=Number(req.body.amount);if(!Number.isFinite(amount))return res.status(400).json({error:'مبلغ نامعتبر است.'});u.wallet=Number(u.wallet||0)+amount;d.payments.unshift({id:uid(),userId:u.id,amount,currency:cfg.currency,status:'ADMIN_ADJUSTMENT',createdAt:Date.now()});save(d);res.json({ok:true,user:publicUser(d,u)})});
app.post('/api/admin/users/:id/role',auth,admin,(req,res)=>{const d=req.db,u=d.users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'کاربر یافت نشد.'});if(u.id===req.user.id&&req.body.role!=='admin')return res.status(400).json({error:'حساب Admin فعلی را نمی‌توان به کاربر عادی تبدیل کرد.'});u.role=req.body.role==='admin'?'admin':'user';save(d);res.json({ok:true,user:publicUser(d,u)})});
app.post('/api/admin/settings/bank',auth,admin,(req,res)=>{const d=req.db;d.settings={...d.settings,bankName:String(req.body.bankName||'').trim(),accountHolder:String(req.body.accountHolder||'').trim(),cardNumber:String(req.body.cardNumber||'').trim(),iban:String(req.body.iban||'').trim(),bankNote:String(req.body.bankNote||'').trim()};save(d);res.json({ok:true,bank:safePublicSettings(d)})});

function canvasFor(ratio,quality){const full=quality==='ultra';if(ratio==='720:1280')return full?'768x1344 · 9:16 full':'544x960 · 9:16 fast';if(ratio==='960:960')return full?'768x768 · 1:1 full':'544x544 · 1:1 fast';return full?'1344x768 · 16:9 full':quality==='high'?'1024x576 · 16:9 fast':'960x544 · 16:9 fast'}
function findOutputUrl(value){let found=null;const walk=x=>{if(found||x==null)return;if(typeof x==='string'){if(/^https?:\/\//i.test(x))found=x;return}if(Array.isArray(x))return x.forEach(walk);if(typeof x==='object'){for(const k of ['url','video_url','download_url']){if(typeof x[k]==='string'&&/^https?:\/\//i.test(x[k])){found=x[k];return}}if(typeof x.video?.url==='string'&&/^https?:\/\//i.test(x.video.url)){found=x.video.url;return}Object.values(x).forEach(walk)}};walk(value);return found}
function extractProgress(value){let best=null;const walk=(x,key='')=>{if(x==null||best!==null)return;if(typeof x==='object'){for(const [k,v] of Object.entries(x)){const lk=k.toLowerCase();if(typeof v==='number'&&Number.isFinite(v)){if(/percent|percentage|progress/.test(lk)){best=v<=1?v*100:v;return}}if(v&&typeof v==='object'&&/progress/.test(lk)){if(typeof v.progress=== 'number') {best=v.progress<=1?v.progress*100:v.progress;return}if(typeof v.current==='number'&&typeof v.total==='number'&&v.total>0){best=v.current/v.total*100;return}}walk(v,lk);if(best!==null)return}}else if(Array.isArray(x)){for(const v of x){walk(v,key);if(best!==null)return}}};walk(value);return best===null?null:Math.max(0,Math.min(99,Math.round(best)))}
function findOutputPath(value){let found=null;const walk=x=>{if(found||x==null)return;if(Array.isArray(x))return x.forEach(walk);if(typeof x==='object'){if(typeof x.path==='string'&&x.path)found=x.path;else Object.values(x).forEach(walk)}};walk(value);return found}
async function submitFreeH3(prompt,duration,ratio,quality,upsample){const d=Math.max(2,Math.min(14,Number(duration)||5));const q=quality==='ultra'?'ultra':quality==='high'?'high':'fast';const steps=q==='ultra'?18:q==='high'?14:10;const args=[prompt,null,null,canvasFor(ratio,q),d,steps,42,Boolean(upsample)];const rr=await fetch(`${cfg.freeUrl}/gradio_api/call/generate`,{method:'POST',headers:{'Content-Type':'application/json',...(cfg.freeKey?{Authorization:`Bearer ${cfg.freeKey}`}:{})},body:JSON.stringify({data:args}),signal:AbortSignal.timeout(45000)});const body=await rr.json().catch(()=>({}));if(!rr.ok||!body.event_id)throw Error(body.error||`Free Engine HTTP ${rr.status}`);return{eventId:body.event_id,duration:d,quality:q,steps}}
const freePollers=new Set();
async function pollFreeH3(job){if(freePollers.has(job.taskId))return false;freePollers.add(job.taskId);try{const rr=await fetch(`${cfg.freeUrl}/gradio_api/call/generate/${encodeURIComponent(job.taskId)}`,{headers:cfg.freeKey?{Authorization:`Bearer ${cfg.freeKey}`}:{},signal:AbortSignal.timeout(27*60*1000)});if(!rr.ok)throw Error(`Free Engine status HTTP ${rr.status}`);if(!rr.body)throw Error('Free Engine پاسخ زنده (SSE) ندارد.');const reader=rr.body.getReader(),decoder=new TextDecoder();let buffer='',complete=null,failed=null;const consume=block=>{const normalized=block.replace(/\r/g,'');const em=normalized.match(/(?:^|\n)event:\s*([^\n]+)/),lines=normalized.split('\n').filter(x=>/^data:\s*/.test(x));if(!em||!lines.length)return;const raw=lines.map(x=>x.replace(/^data:\s*/,'')).join('').trim();let data;try{data=JSON.parse(raw)}catch{data=raw}const eventName=em[1].trim();if(eventName==='complete')complete=data;if(eventName==='error')failed=data;if(eventName==='generating'||eventName==='status'||eventName==='process_starts'){const p=extractProgress(data),s=(data&&typeof data==='object')?data:{};const d=db(),j=d.jobs.find(x=>x.taskId===job.taskId);if(j){if(p!==null){j.progress=p;j.pollFailures=0;j.lastPollError=null;}const findNum=(v,keys)=>{let out=null;const walk=x=>{if(out!==null||x==null)return;if(Array.isArray(x)){for(const z of x)walk(z);return}if(typeof x!=='object')return;for(const [k,v] of Object.entries(x)){if(keys.includes(k.toLowerCase())&&typeof v==='number'&&Number.isFinite(v)){out=v;return}walk(v);if(out!==null)return}};walk(v);return out};const findVal=(v,keys)=>{let out=null;const walk=x=>{if(out!==null||x==null)return;if(Array.isArray(x)){for(const z of x)walk(z);return}if(typeof x!=='object')return;for(const [k,v] of Object.entries(x)){if(keys.includes(k.toLowerCase())&&typeof v==='string'){out=v;return}walk(v);if(out!==null)return}};walk(v);return out};const eta=findNum(data,['eta']);const pos=findNum(data,['position','rank']);const qs=findNum(data,['queue_size','queueSize','size']);const stage=findVal(data,['stage','status']);if(eta!==null)j.eta=Math.max(0,Math.round(eta));if(pos!==null)j.queuePosition=pos;if(qs!==null)j.queueSize=qs;if(stage)j.stage=stage;const pd=findNum(data,['progress']);if(pd!==null)j.progress=Math.max(0,Math.min(99,Math.round((pd<=1?pd*100:pd))));activeJobs.set(j.taskId,j);save(d)}}};while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop()||'';for(const b of blocks)consume(b);if(failed||complete)break}if(buffer)consume(buffer);if(failed)throw Error(typeof failed==='string'?failed:JSON.stringify(failed));if(!complete)throw Error('Free Engine نتیجه نهایی را برنگرداند.');const url=findOutputUrl(complete);const outputPath=url?null:findOutputPath(complete);const finalUrl=url||(outputPath?cfg.freeUrl+'/gradio_api/file='+encodeURIComponent(outputPath):null);if(!finalUrl)throw Error('ویدئو ساخته شد ولی لینک خروجی پیدا نشد.');const d=db(),j=d.jobs.find(x=>x.taskId===job.taskId);if(!j)return false;j.status='SUCCEEDED';j.url=finalUrl;j.completedAt=Date.now();j.error=undefined;activeJobs.set(j.taskId,j);save(d);return true}catch(e){const d=db(),j=d.jobs.find(x=>x.taskId===job.taskId);if(j){j.status='FAILED';j.error=e.message||String(e);if(j.cost){const u=d.users.find(x=>x.id===j.userId);if(u)u.wallet=Number(u.wallet||0)+j.cost;j.cost=0;j.refunded=true}activeJobs.set(j.taskId,j);save(d)}return false}finally{freePollers.delete(job.taskId)}}

async function submitVideoWithFallback(prompt,duration,ratio,quality,upsample,promptImage,preferredProvider,model='auto',resolution='720p',seed=null){
  const order=preferredProvider==='free'?['free']:['gemini'];
  const attempts=[];
  for(const provider of order){
    if(provider==='gemini'&&!cfg.geminiKey){attempts.push('gemini: API key missing');continue}
    try{
      if(provider==='gemini') return {provider,submitted:await submitGeminiVeo(prompt,duration,ratio,promptImage,model==='veo-pro'?'veo-pro':'veo-fast',resolution,seed),attempts};
      return {provider:'free',submitted:await submitFreeH3(prompt,duration,ratio,quality,upsample),attempts};
    }catch(e){attempts.push(provider+': '+(e?.message||String(e)));}
  }
  throw Error('موتور واقعی Gemini Veo 3.1 در دسترس نیست. GEMINI_API_KEY را در Railway Variables تنظیم کنید. MiniMax فقط با انتخاب صریح آن فعال است.');
}

app.post('/api/generate',auth,async(req,res)=>{
  const d=req.db,u=req.user,prompt=String(req.body.prompt||'').trim(),negativePrompt=String(req.body.negativePrompt||'').trim(),promptImage=req.body.promptImage||null,hasImage=Boolean(promptImage),duration=Number(req.body.duration||5),model=normalizeVideoModel(req.body.model),resolution=['720p','1080p','4k'].includes(req.body.resolution)?req.body.resolution:'720p',seed=req.body.seed===''||req.body.seed==null?null:Number(req.body.seed);
  if(!prompt)return res.status(400).json({error:'پرامپت را وارد کنید.'});
  if(prompt.length>4000||negativePrompt.length>1000)return res.status(400).json({error:'متن پرامپت بیش از حد مجاز است.'});
  if(seed!==null&&(!Number.isInteger(seed)||seed<0))return res.status(400).json({error:'Seed نامعتبر است.'});
    if(duration<4||duration>30)return res.status(400).json({error:'مدت باید بین ۴ تا ۳۰ ثانیه باشد.'});
  const projectId=String(req.body.projectId||'').trim();
  if(projectId&&!d.projects.some(x=>x.id===projectId&&x.userId===u.id))return res.status(404).json({error:'پروژه پیدا نشد.'});
  const cost=chargeFor(u,d);
  if(cost>0&&Number(u.wallet||0)<cost)return res.status(402).json({error:`سهمیه رایگان امروز تمام شده است. برای ادامه ${cost.toLocaleString('fa-IR')} ${cfg.currency} کیف پول لازم است.`});
  try{
    const preferredProvider=chooseVideoProvider(hasImage,model,duration);
    if(!preferredProvider)return res.status(503).json({error:'هیچ موتور واقعی AI فعال نیست. GEMINI_API_KEY را در Railway Variables تنظیم کنید.'});
    const effectivePrompt=negativePrompt?prompt+'\n\nAvoid: '+negativePrompt:prompt;
    const result=await submitVideoWithFallback(effectivePrompt,duration,req.body.ratio||'1280:720',req.body.quality||'high',req.body.upsample!==false,promptImage,preferredProvider,model,resolution,seed);
    const submitted=result.submitted;
    let job;
    if(result.provider==='openai'){
      job={id:uid(),taskId:uid(),externalId:submitted.externalId,userId:u.id,day:day(),engine:'openai',provider:'openai',model:model==='auto'?'sora-2':model,status:'PROCESSING',createdAt:Date.now(),cost,duration:submitted.duration,requestedDuration:duration,ratio:req.body.ratio||'1280:720',resolution,negativePrompt,seed,projectId,fallbackAttempts:result.attempts};
      d.jobs.unshift(job);activeJobs.set(job.taskId,job);if(cost)u.wallet-=cost;save(d);
      return res.json({taskId:job.taskId,model:job.model,duration:job.duration,requestedDuration:job.requestedDuration,engine:'openai',provider:'openai',fallbackAttempts:result.attempts});
    }
    if(result.provider==='gemini'){
      job={id:uid(),taskId:uid(),externalId:submitted.externalId,userId:u.id,day:day(),engine:'gemini',provider:'gemini',model:model==='auto'?'veo-fast':model,status:'PROCESSING',createdAt:Date.now(),cost,duration:submitted.duration,requestedDuration:duration,ratio:req.body.ratio||'1280:720',resolution,negativePrompt,seed,projectId,fallbackAttempts:result.attempts};
      d.jobs.unshift(job);activeJobs.set(job.taskId,job);if(cost)u.wallet-=cost;save(d);
      return res.json({taskId:job.taskId,model:job.model,duration:job.duration,requestedDuration:job.requestedDuration,engine:'gemini',provider:'gemini',fallbackAttempts:result.attempts});
    }
    job={id:uid(),taskId:submitted.eventId,userId:u.id,day:day(),engine:'free',provider:'free',model:'minimax-h3',status:'PROCESSING',createdAt:Date.now(),cost,duration:submitted.duration,quality:submitted.quality,steps:submitted.steps,fallbackAttempts:result.attempts};
    d.jobs.unshift(job);activeJobs.set(job.taskId,job);if(cost)u.wallet-=cost;save(d);pollFreeH3(job).catch(()=>{});
    return res.json({taskId:job.taskId,model:'MiniMax-H3 Free Engine',duration:job.duration,engine:'free',provider:'free',quality:submitted.quality,steps:submitted.steps,fallbackAttempts:result.attempts});
  }catch(e){res.status(502).json({error:e.message||'خطا در موتور تولید'})}
});
app.post('/api/tasks/:id/cancel',auth,(req,res)=>{const d=req.db,j=d.jobs.find(x=>x.taskId===req.params.id&&x.userId===req.user.id);if(!j)return res.status(404).json({error:'Job پیدا نشد.'});if(j.status!=='PROCESSING')return res.json({status:j.status});j.status='CANCELED';j.canceledAt=Date.now();if(j.cost){req.user.wallet=Number(req.user.wallet||0)+j.cost;j.cost=0;j.refunded=true}save(d);activeJobs.delete(j.taskId);res.json({status:j.status})});
app.get('/api/tasks/:id',auth,async(req,res)=>{
  const taskId=req.params.id;
  const cached=activeJobs.get(taskId);
  const d=req.db,u=req.user;
  const j=cached&&cached.userId===u.id?cached:d.jobs.find(x=>x.taskId===taskId&&x.userId===u.id);
  if(!j)return res.status(404).json({error:'Job پیدا نشد.'});
  try{
    if(j.status==='PROCESSING'&&j.provider==='openai') await refreshOpenAISora(j);
    else if(j.status==='PROCESSING'&&j.provider==='gemini') await refreshGeminiVeo(j);
    else if(j.status==='PROCESSING'&&j.provider==='free') { pollFreeH3(j).catch(()=>{}); const latest=db().jobs.find(x=>x.taskId===taskId&&x.userId===u.id); if(latest) { activeJobs.set(taskId,latest); } }
    if(['FAILED','CANCELED'].includes(j.status)&&j.cost){
      u.wallet=Number(u.wallet||0)+j.cost;j.cost=0;j.refunded=true;
    }
    if(j.provider!=='free') { activeJobs.set(j.taskId,j); save(d); }
  }catch(e){
    j.lastPollError=e.message||String(e);
    j.pollFailures=(j.pollFailures||0)+1;
    if(j.pollFailures>=6 && j.status==='PROCESSING'){
      j.status='FAILED';
      j.error=j.lastPollError;
      if(j.cost){u.wallet=Number(u.wallet||0)+j.cost;j.cost=0;j.refunded=true}
      j.finishedAt=Date.now();
    }
    activeJobs.set(j.taskId,j);save(d)
  }
  const fresh=j.provider==='free'?db().jobs.find(x=>x.taskId===taskId&&x.userId===u.id):j;
  const out=fresh||j;
  const url=out.status==='SUCCEEDED'&&out.provider==='openai'?'/api/tasks/'+encodeURIComponent(out.taskId)+'/video?token='+encodeURIComponent(req.token):
    out.status==='SUCCEEDED'&&out.provider==='gemini'?'/api/tasks/'+encodeURIComponent(out.taskId)+'/video?token='+encodeURIComponent(req.token):
    out.url||null;
  res.json({status:out.status,url,error:out.error,lastPollError:out.lastPollError||null,pollFailures:out.pollFailures||0,engine:out.engine,provider:out.provider,quality:out.quality,steps:out.steps,progress:typeof out.progress==='number'?out.progress:null,stage:out.stage||null,eta:typeof out.eta==='number'?out.eta:null,queuePosition:typeof out.queuePosition==='number'?out.queuePosition:null,queueSize:typeof out.queueSize==='number'?out.queueSize:null});
});

async function processJob(job){
  if(!job||job.status!=='PROCESSING')return;
  try{
    if(job.provider==='openai')await refreshOpenAISora(job);
    else if(job.provider==='gemini')await refreshGeminiVeo(job);
    else if(job.provider==='free')await pollFreeH3(job);
    const d=db(),j=d.jobs.find(x=>x.taskId===job.taskId);
    if(j){
      if(j.status==='SUCCEEDED'||j.status==='FAILED')j.finishedAt=j.finishedAt||Date.now();
      j.lastPolledAt=Date.now();
      activeJobs.set(j.taskId,j);save(d);
      if(j.status==='FAILED'&&j.cost){const u=d.users.find(x=>x.id===j.userId);if(u)u.wallet=Number(u.wallet||0)+j.cost;j.cost=0;j.refunded=true;save(d)}
    }
  }catch(e){
    const d=db(),j=d.jobs.find(x=>x.taskId===job.taskId);
    if(j){
      j.lastPollError=e.message||String(e);
      j.pollFailures=(j.pollFailures||0)+1;
      j.lastPolledAt=Date.now();
      if(j.pollFailures>=6&&j.status==='PROCESSING'){
        j.status='FAILED';j.error=j.lastPollError;j.finishedAt=Date.now();
        if(j.cost){const u=d.users.find(x=>x.id===j.userId);if(u)u.wallet=Number(u.wallet||0)+j.cost;j.cost=0;j.refunded=true}
      }
      activeJobs.set(j.taskId,j);save(d)
    }
  }
}
async function processAllJobs(){
  const d=db();
  const jobs=d.jobs.filter(x=>x.status==='PROCESSING').slice(0,20);
  await Promise.allSettled(jobs.map(processJob));
}
setInterval(()=>{processAllJobs().catch(()=>{})},5000);
setTimeout(()=>{processAllJobs().catch(()=>{})},1500);

app.get('/api/tasks/:id/video',async(req,res)=>{
  const t=String(req.query.token||'').replace(/^Bearer\s+/i,'');
  const s=sessions.get(t);if(!s)return res.status(401).send('نیاز به ورود دارید.');
  const d=db(),j=d.jobs.find(x=>x.taskId===req.params.id&&x.userId===s.id);
  if(!j||j.status!=='SUCCEEDED')return res.status(404).send('ویدئو آماده نیست.');
  try{
    if(j.provider==='openai'){
      const rr=await fetch(cfg.openaiBase+'/videos/'+encodeURIComponent(j.externalId)+'/content',{headers:{Authorization:'Bearer '+cfg.openaiKey},signal:AbortSignal.timeout(180000)});
      if(!rr.ok)return res.status(rr.status).send(await rr.text());
      return sendMp4(res,Buffer.from(await rr.arrayBuffer()),'openai');
    }
    if(j.provider==='gemini'){
      const uri=j.providerVideoUrl;if(!uri)return res.status(404).send('لینک ویدئو پیدا نشد.');
      const rr=await fetch(uri,{headers:{'x-goog-api-key':cfg.geminiKey},signal:AbortSignal.timeout(180000)});
      if(!rr.ok)return res.status(rr.status).send(await rr.text());
      return sendMp4(res,Buffer.from(await rr.arrayBuffer()),'gemini');
    }
    return res.status(404).send('Provider نامعتبر است.');
  }catch(e){res.status(502).send(e.message||'خطا در دریافت ویدئو.')}
});
app.get('/api/admin',auth,admin,(req,res)=>res.json({ok:true}));
app.use((err,req,res,next)=>{
  const message=err?.message||'خطای داخلی سرور.';
  console.error('[Ayaz Video Maker]',message);
  if(res.headersSent)return next(err);
  res.status(500).json({error:message});
});

app.use(express.static(__dirname));app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>{const indexPath=getIndexFilePath();if(indexPath)return res.sendFile(indexPath);res.status(404).send('index.html پیدا نشد.')});
app.listen(PORT,()=>console.log(`Ayaz Video Maker Pro listening on ${PORT}`));
