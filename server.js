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

const PORT = Number(process.env.PORT || 10000);
const DB = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const cfg = {
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
  currency: process.env.CURRENCY || 'IRT'
};

function getIndexFilePath() {
  for (const p of [path.join(__dirname,'index.html'), path.join(__dirname,'public','index.html'), path.join(process.cwd(),'index.html'), path.join(process.cwd(),'public','index.html')]) if (fs.existsSync(p)) return p;
  return null;
}
function ensure(){ fs.mkdirSync(path.dirname(DB),{recursive:true}); if(!fs.existsSync(DB)) fs.writeFileSync(DB,JSON.stringify({users:[],payments:[],jobs:[],settings:{bankName:'',accountHolder:'',cardNumber:'',iban:'',bankNote:''}},null,2)); }
function db(){ ensure(); let d; try{d=JSON.parse(fs.readFileSync(DB,'utf8'))}catch{d={users:[],payments:[],jobs:[],settings:{}}} d.users??=[];d.payments??=[];d.jobs??=[];d.settings??={};return d; }
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
function safePublicSettings(d){return{bankName:d.settings.bankName||'',accountHolder:d.settings.accountHolder||'',cardNumber:d.settings.cardNumber||'',iban:d.settings.iban||'',bankNote:d.settings.bankNote||''}}

app.get('/api/health',(req,res)=>res.json({ok:true,configured:Boolean(cfg.runwayKey),freeEngineConfigured:Boolean(cfg.freeUrl),freeEngine:'MiniMax-H3',model:'seedance2_5',minDuration:4,maxDuration:30,dailyFreeUser:cfg.userFree,dailyFreeAdmin:cfg.adminFree,pricePerVideo:cfg.price,currency:cfg.currency,zarinpalConfigured:Boolean(cfg.zMerchant&&cfg.zCallback)}));
app.post('/api/auth/register',(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!/^\S+@\S+\.\S+$/.test(email)||password.length<6)return res.status(400).json({error:'ایمیل معتبر و رمز عبور حداقل ۶ کاراکتری لازم است.'});const d=db();if(d.users.some(u=>u.email===email))return res.status(409).json({error:'این کاربر قبلاً ثبت شده است.'});const u={id:uid(),email,passwordHash:hash(password),role:'user',wallet:0,createdAt:Date.now()};d.users.push(u);save(d);const t=token(u.id);sessions.set(t,{id:u.id});res.json({token:t,user:publicUser(d,u)})});
app.post('/api/auth/login',(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const d=db();let u=d.users.find(x=>x.email===email);if(!u&&email===cfg.adminEmail){u={id:'admin',email:cfg.adminEmail,passwordHash:hash(cfg.adminPassword),role:'admin',wallet:0,createdAt:Date.now()};d.users.push(u);save(d)}if(!u||!check(password,u.passwordHash))return res.status(401).json({error:'ایمیل یا رمز عبور نادرست است.'});const t=token(u.id);sessions.set(t,{id:u.id});res.json({token:t,user:publicUser(d,u)})});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:publicUser(req.db,req.user)}));
app.post('/api/auth/logout',auth,(req,res)=>{sessions.delete(req.token);res.json({ok:true})});
app.get('/api/wallet',auth,(req,res)=>res.json({wallet:Number(req.user.wallet||0),usage:usage(req.db,req.user),pricePerVideo:cfg.price,currency:cfg.currency,bank:safePublicSettings(req.db)}));
app.get('/api/jobs',auth,(req,res)=>res.json({jobs:req.db.jobs.filter(x=>x.userId===req.user.id).slice(0,100)}));
app.get('/api/payments',auth,(req,res)=>res.json({payments:req.db.payments.filter(x=>x.userId===req.user.id).slice(0,100)}));
app.post('/api/payment/zarinpal/request',auth,async(req,res)=>{const amount=Math.floor(Number(req.body.amount||0));if(!Number.isFinite(amount)||amount<1000)return res.status(400).json({error:'مبلغ شارژ حداقل ۱۰۰۰ است.'});if(!cfg.zMerchant||!cfg.zCallback)return res.status(503).json({error:'زرین‌پال هنوز در تنظیمات سرور فعال نشده است.'});const d=req.db,id=uid(),p={id,userId:req.user.id,amount,currency:cfg.currency,status:'PENDING',createdAt:Date.now()};d.payments.push(p);save(d);try{const r=await callJson(`${cfg.zBase}/request.json`,{merchant_id:cfg.zMerchant,amount,callback_url:`${cfg.zCallback}${cfg.zCallback.includes('?')?'&':'?'}payment_id=${id}`,description:`شارژ کیف پول Ayaz - ${req.user.email}`,metadata:{email:req.user.email}});const authority=r?.data?.authority;if(!authority)throw Error(r?.errors?.message||'Authority دریافت نشد.');p.authority=authority;save(d);res.json({ok:true,paymentId:id,authority,url:`https://www.zarinpal.com/pg/StartPay/${authority}`})}catch(e){p.status='FAILED';p.error=e.message;save(d);res.status(502).json({error:'خطا در ایجاد پرداخت زرین‌پال: '+e.message})}});
app.get('/api/payment/zarinpal/callback',async(req,res)=>{const id=String(req.query.payment_id||''),authority=String(req.query.Authority||''),status=String(req.query.Status||'');const d=db(),p=d.payments.find(x=>x.id===id);if(!p)return res.status(404).send('تراکنش پیدا نشد.');if(p.status==='PAID')return res.send('این تراکنش قبلاً تأیید شده است.');if(status!=='OK'){p.status='CANCELED';save(d);return res.send('پرداخت لغو شد.')}try{const r=await callJson(`${cfg.zBase}/verify.json`,{merchant_id:cfg.zMerchant,authority,amount:p.amount});const code=Number(r?.data?.code);if(code===100||code===101){p.status='PAID';p.refId=r?.data?.ref_id||null;p.verifiedAt=Date.now();const u=d.users.find(x=>x.id===p.userId);if(u)u.wallet=Number(u.wallet||0)+p.amount;save(d);return res.send('پرداخت با موفقیت تأیید شد. می‌توانید به سایت برگردید.')}p.status='FAILED';p.error=r?.errors?.message||`code ${code}`;save(d);res.status(400).send('تأیید پرداخت ناموفق بود.')}catch(e){p.status='FAILED';p.error=e.message;save(d);res.status(502).send('خطا در تأیید پرداخت: '+e.message)}});
app.get('/api/admin/overview',auth,admin,(req,res)=>{const d=req.db;res.json({users:d.users.map(u=>publicUser(d,u)),payments:d.payments.slice(0,200),jobs:d.jobs.slice(0,200),settings:{dailyFreeUser:cfg.userFree,dailyFreeAdmin:cfg.adminFree,pricePerVideo:cfg.price,currency:cfg.currency,freeEngineConfigured:Boolean(cfg.freeUrl),runwayConfigured:Boolean(cfg.runwayKey),zarinpalConfigured:Boolean(cfg.zMerchant&&cfg.zCallback),bank:safePublicSettings(d)}})});
app.post('/api/admin/users/:id/credit',auth,admin,(req,res)=>{const d=req.db,u=d.users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'کاربر یافت نشد.'});const amount=Number(req.body.amount);if(!Number.isFinite(amount))return res.status(400).json({error:'مبلغ نامعتبر است.'});u.wallet=Number(u.wallet||0)+amount;d.payments.unshift({id:uid(),userId:u.id,amount,currency:cfg.currency,status:'ADMIN_ADJUSTMENT',createdAt:Date.now()});save(d);res.json({ok:true,user:publicUser(d,u)})});
app.post('/api/admin/users/:id/role',auth,admin,(req,res)=>{const d=req.db,u=d.users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'کاربر یافت نشد.'});if(u.id===req.user.id&&req.body.role!=='admin')return res.status(400).json({error:'حساب Admin فعلی را نمی‌توان به کاربر عادی تبدیل کرد.'});u.role=req.body.role==='admin'?'admin':'user';save(d);res.json({ok:true,user:publicUser(d,u)})});
app.post('/api/admin/settings/bank',auth,admin,(req,res)=>{const d=req.db;d.settings={...d.settings,bankName:String(req.body.bankName||'').trim(),accountHolder:String(req.body.accountHolder||'').trim(),cardNumber:String(req.body.cardNumber||'').trim(),iban:String(req.body.iban||'').trim(),bankNote:String(req.body.bankNote||'').trim()};save(d);res.json({ok:true,bank:safePublicSettings(d)})});

function canvasFor(ratio,quality){const full=quality==='ultra';if(ratio==='720:1280')return full?'768x1344 · 9:16 full':'544x960 · 9:16 fast';if(ratio==='960:960')return full?'768x768 · 1:1 full':'544x544 · 1:1 fast';return full?'1344x768 · 16:9 full':quality==='high'?'1024x576 · 16:9 fast':'960x544 · 16:9 fast'}
function findOutputUrl(value){let found=null;const walk=x=>{if(found||x==null)return;if(typeof x==='string'){if(/^https?:\/\//i.test(x))found=x;return}if(Array.isArray(x))return x.forEach(walk);if(typeof x==='object'){if(typeof x.url==='string'){found=x.url;return}if(typeof x.video?.url==='string'){found=x.video.url;return}Object.values(x).forEach(walk)}};walk(value);return found}
async function submitFreeH3(prompt,duration,ratio,quality,upsample){const d=Math.max(2,Math.min(15,Number(duration)||5));const q=quality==='ultra'?'ultra':quality==='high'?'high':'fast';const steps=q==='ultra'?40:q==='high'?32:24;const args=[prompt,null,null,canvasFor(ratio,q),d,steps,42,Boolean(upsample)];const rr=await fetch(`${cfg.freeUrl}/gradio_api/call/generate`,{method:'POST',headers:{'Content-Type':'application/json',...(cfg.freeKey?{Authorization:`Bearer ${cfg.freeKey}`}:{})},body:JSON.stringify({data:args}),signal:AbortSignal.timeout(45000)});const body=await rr.json().catch(()=>({}));if(!rr.ok||!body.event_id)throw Error(body.error||`Free Engine HTTP ${rr.status}`);return{eventId:body.event_id,duration:d,quality:q,steps}}
const freePollers=new Set();
async function pollFreeH3(job){if(freePollers.has(job.taskId))return false;freePollers.add(job.taskId);try{const rr=await fetch(`${cfg.freeUrl}/gradio_api/call/generate/${encodeURIComponent(job.taskId)}`,{headers:cfg.freeKey?{Authorization:`Bearer ${cfg.freeKey}`}:{},signal:AbortSignal.timeout(27*60*1000)});if(!rr.ok)throw Error(`Free Engine status HTTP ${rr.status}`);if(!rr.body)throw Error('Free Engine پاسخ زنده (SSE) ندارد.');const reader=rr.body.getReader(),decoder=new TextDecoder();let buffer='',complete=null,failed=null;const consume=block=>{const em=block.match(/(?:^|\n)event:\s*([^\n]+)/),dm=block.match(/(?:^|\n)data:\s*([\s\S]*?)(?:\n|$)/);if(!em||!dm)return;let data;try{data=JSON.parse(dm[1].trim())}catch{data=dm[1].trim()}if(em[1].trim()==='complete')complete=data;if(em[1].trim()==='error')failed=data};while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const blocks=buffer.split(/\n\n/);buffer=blocks.pop()||'';for(const b of blocks)consume(b);if(failed||complete)break}if(buffer)consume(buffer);if(failed)throw Error(typeof failed==='string'?failed:JSON.stringify(failed));if(!complete)throw Error('Free Engine نتیجه نهایی را برنگرداند.');const url=findOutputUrl(complete);if(!url)throw Error('ویدئو ساخته شد ولی لینک خروجی پیدا نشد.');const d=db(),j=d.jobs.find(x=>x.taskId===job.taskId);if(!j)return false;j.status='SUCCEEDED';j.url=url;j.completedAt=Date.now();j.error=undefined;activeJobs.set(j.taskId,j);save(d);return true}catch(e){const d=db(),j=d.jobs.find(x=>x.taskId===job.taskId);if(j){j.status='FAILED';j.error=e.message||String(e);if(j.cost){const u=d.users.find(x=>x.id===j.userId);if(u)u.wallet=Number(u.wallet||0)+j.cost;j.cost=0;j.refunded=true}activeJobs.set(j.taskId,j);save(d)}return false}finally{freePollers.delete(job.taskId)}}

app.post('/api/generate',auth,async(req,res)=>{const d=req.db,u=req.user,prompt=String(req.body.prompt||'').trim(),promptImage=req.body.promptImage||null,hasImage=Boolean(promptImage),engine=hasImage?'runway':'free',duration=Number(req.body.duration||5);if(!prompt)return res.status(400).json({error:'پرامپت را وارد کنید.'});if(duration<4||duration>30)return res.status(400).json({error:'مدت باید بین ۴ تا ۳۰ ثانیه باشد.'});const cost=chargeFor(u,d);if(cost>0&&Number(u.wallet||0)<cost)return res.status(402).json({error:`سهمیه رایگان امروز تمام شده است. برای ادامه ${cost.toLocaleString('fa-IR')} ${cfg.currency} کیف پول لازم است.`});try{if(engine==='runway'){if(!cfg.runwayKey)return res.status(503).json({error:'برای تبدیل تصویر به ویدئو، Runway روی سرور تنظیم نشده است.'});const body={model:'seedance2_5',promptText:prompt,duration,ratio:req.body.ratio||'1280:720',promptImage};const result=await callJson(`${cfg.runwayBase}/text_to_video`,body,{Authorization:`Bearer ${cfg.runwayKey}`,'X-Runway-API-Version':'2024-11-06'});const taskId=result.id||result.taskId||result.data?.id;if(!taskId)throw Error('Runway شناسه Job برنگرداند.');const job={id:uid(),taskId,userId:u.id,day:day(),engine,status:'PROCESSING',createdAt:Date.now(),cost,duration};d.jobs.unshift(job);activeJobs.set(taskId,job);if(cost)u.wallet-=cost;save(d);return res.json({taskId,model:'Runway',duration,engine})}const submitted=await submitFreeH3(prompt,duration,req.body.ratio||'1280:720',req.body.quality||'high',req.body.upsample!==false);const job={id:uid(),taskId:submitted.eventId,userId:u.id,day:day(),engine:'free',status:'PROCESSING',createdAt:Date.now(),cost,duration:submitted.duration,quality:submitted.quality,steps:submitted.steps};d.jobs.unshift(job);activeJobs.set(job.taskId,job);if(cost)u.wallet-=cost;save(d);pollFreeH3(job).catch(()=>{});res.json({taskId:job.taskId,model:'MiniMax-H3 Free Engine',duration:submitted.duration,engine:'free',quality:submitted.quality,steps:submitted.steps})}catch(e){res.status(502).json({error:e.message||'خطا در موتور تولید'})}});
app.get('/api/tasks/:id',auth,async(req,res)=>{
  const taskId=req.params.id;
  const cached=activeJobs.get(taskId);
  if(cached&&cached.userId===req.user.id&&cached.engine==='free'){
    return res.json({status:cached.status,url:cached.url,error:cached.error,engine:cached.engine,quality:cached.quality,steps:cached.steps});
  }
  const d=req.db,u=req.user,j=d.jobs.find(x=>x.taskId===taskId&&x.userId===u.id);
  if(!j)return res.status(404).json({error:'Job پیدا نشد.'});
  if(j.status==='PROCESSING'&&j.engine==='runway'){
    try{
      const rr=await fetch(`${cfg.runwayBase}/tasks/${encodeURIComponent(j.taskId)}`,{
        headers:{Authorization:`Bearer ${cfg.runwayKey}`,'X-Runway-API-Version':'2024-11-06'},
        signal:AbortSignal.timeout(30000)
      });
      const r=await rr.json().catch(()=>({}));
      if(rr.ok){
        j.status=r.status||j.status;
        j.url=r.output?.[0]||r.output?.video_url||j.url;
        j.error=r.failure||r.error||j.error;
      }else{
        j.error=r?.error?.message||r?.error||`Runway HTTP ${rr.status}`;
      }
      activeJobs.set(j.taskId,j);
      if(['FAILED','CANCELED'].includes(j.status)&&j.cost){
        u.wallet=Number(u.wallet||0)+j.cost;
        j.cost=0;
        j.refunded=true;
      }
      save(d);
    }catch(e){
      j.error=e.message||String(e);
      activeJobs.set(j.taskId,j);
      save(d);
    }
  }
  res.json({status:j.status,url:j.url,error:j.error,engine:j.engine,quality:j.quality,steps:j.steps});
});
app.get('/api/admin',auth,admin,(req,res)=>res.json({ok:true}));
app.use(express.static(__dirname));app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>{const indexPath=getIndexFilePath();if(indexPath)return res.sendFile(indexPath);res.status(404).send('index.html پیدا نشد.')});
app.listen(PORT,()=>console.log(`Ayaz Video Maker Pro listening on ${PORT}`));
