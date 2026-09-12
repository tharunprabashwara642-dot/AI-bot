import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT=Number(process.env.PORT||8080);
const TG=process.env.TELEGRAM_BOT_TOKEN;
const APIKEY=process.env.TABITOKEN_API_KEY;
const BASE=(process.env.TABITOKEN_BASE_URL||"https://tabitoken.com/v1").replace(/\/+$/,'');
const MODEL=process.env.CLAUDE_MODEL||"claude-sonnet-5";
const AUTH=process.env.LOCAL_ANTHROPIC_AUTH_TOKEN||crypto.randomBytes(24).toString("hex");
const WORKDIR=process.env.CLAUDE_WORKDIR||"/app/workspace";
const TIMEOUT=Number(process.env.CLAUDE_TIMEOUT_MS||1800000);
const ALLOWED=new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS||"").split(',').map(x=>x.trim()).filter(Boolean));
if(!TG) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if(!APIKEY) throw new Error("Missing TABITOKEN_API_KEY");

fs.mkdirSync(WORKDIR,{recursive:true});

const app=express(); app.use(express.json({limit:"20mb"}));
app.get('/',(_,r)=>r.json({ok:true,service:"claude-code-telegram",model:MODEL,provider:"tabitoken"}));
app.get('/health',(_,r)=>r.json({ok:true,model:MODEL}));
const authOK=req=>req.headers.authorization===`Bearer ${AUTH}`||req.headers['x-api-key']===AUTH;
const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text||'').join(''):'';
function toOpenAI(b){
  const m=[];
  if(b.system)m.push({role:'system',content:Array.isArray(b.system)?b.system.map(x=>x.text||'').join('\n'):String(b.system)});
  for(const x of b.messages||[]){
    if(x.role==='user'&&Array.isArray(x.content)){
      for(const z of x.content) if(z?.type==='tool_result') m.push({role:'tool',tool_call_id:z.tool_use_id,content:text(z.content)});
      const t=text(x.content); if(t.trim())m.push({role:'user',content:t});
    } else if(x.role==='assistant'&&Array.isArray(x.content)){
      const t=text(x.content), tc=x.content.filter(z=>z?.type==='tool_use').map(z=>({id:z.id,type:'function',function:{name:z.name,arguments:JSON.stringify(z.input??{})}}));
      const q={role:'assistant',content:t||''}; if(tc.length)q.tool_calls=tc; m.push(q);
    } else m.push({role:x.role,content:text(x.content)});
  }
  return m;
}
function tools(ts){return Array.isArray(ts)?ts.map(t=>({type:'function',function:{name:t.name,description:t.description||'',parameters:t.input_schema||{type:'object',properties:{}}}})):undefined}
function anthropic(data,model){
  const msg=data?.choices?.[0]?.message||{}, content=[];
  if(msg.content)content.push({type:'text',text:String(msg.content)});
  for(const q of msg.tool_calls||[]){let input={};try{input=JSON.parse(q.function?.arguments||'{}')}catch{} content.push({type:'tool_use',id:q.id||`tool_${crypto.randomUUID()}`,name:q.function?.name||'tool',input})}
  return {id:data?.id||`msg_${crypto.randomUUID()}`,type:'message',role:'assistant',model,content,stop_reason:(msg.tool_calls||[]).length?'tool_use':data?.choices?.[0]?.finish_reason==='length'?'max_tokens':'end_turn',stop_sequence:null,usage:{input_tokens:data?.usage?.prompt_tokens||0,output_tokens:data?.usage?.completion_tokens||0,cache_creation_input_tokens:0,cache_read_input_tokens:0}};
}
function sse(r,x){r.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)}
function stream(r,m){sse(r,{type:'message_start',message:{...m,content:[],stop_reason:null,stop_sequence:null}});let i=0;for(const b of m.content||[]){sse(r,{type:'content_block_start',index:i,content_block:b.type==='tool_use'?{type:'tool_use',id:b.id,name:b.name,input:{}}:{type:'text',text:''}});if(b.type==='text')sse(r,{type:'content_block_delta',index:i,delta:{type:'text_delta',text:b.text}});else sse(r,{type:'content_block_delta',index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input||{})}});sse(r,{type:'content_block_stop',index:i++})}sse(r,{type:'message_delta',delta:{stop_reason:m.stop_reason,stop_sequence:null},usage:{output_tokens:m.usage.output_tokens}});sse(r,{type:'message_stop'});r.end()}
app.post('/v1/messages',async(req,res)=>{
  if(!authOK(req))return res.status(401).json({type:'error',error:{type:'authentication_error',message:'Unauthorized'}});
  try{const b=req.body||{}, q={model:b.model||MODEL,messages:toOpenAI(b),max_tokens:Number(b.max_tokens||8192),stream:false};const ts=tools(b.tools);if(ts?.length)q.tools=ts;if(b.tool_choice?.type==='auto')q.tool_choice='auto';if(b.tool_choice?.type==='any')q.tool_choice='required';if(b.tool_choice?.type==='tool')q.tool_choice={type:'function',function:{name:b.tool_choice.name}};
    const u=await fetch(`${BASE}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${APIKEY}`},body:JSON.stringify(q)}),raw=await u.text();let d;try{d=JSON.parse(raw)}catch{d={raw}};if(!u.ok)return res.status(u.status).json({type:'error',error:{type:'api_error',message:`TabiToken ${u.status}: ${raw.slice(0,4000)}`}});const m=anthropic(d,b.model||MODEL);if(b.stream){res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');return stream(res,m)}res.json(m);
  }catch(e){res.status(500).json({type:'error',error:{type:'api_error',message:String(e?.message||e)}})}
});

const active=new Map();
const allowed=m=>!ALLOWED.size||ALLOWED.has(String(m.chat.id))||ALLOWED.has(String(m.from?.id));
const clip=(s,n=3900)=>String(s||'').length<=n?String(s||''):String(s||'').slice(0,n)+'\n…[truncated]';
function runClaude(prompt,chat){return new Promise((resolve,reject)=>{
  const env={...process.env,HOME:process.env.HOME||'/home/agent',ANTHROPIC_BASE_URL:`http://127.0.0.1:${PORT}`,ANTHROPIC_AUTH_TOKEN:AUTH,ANTHROPIC_MODEL:MODEL};
  console.log(`[claude] starting chat=${chat} uid=${process.getuid?.()??'unknown'} cwd=${WORKDIR} model=${MODEL}`);
  const p=spawn('claude',['-p',prompt,'--output-format','text','--dangerously-skip-permissions'],{cwd:WORKDIR,env,stdio:['ignore','pipe','pipe']});
  let out='',err='';const started=Date.now();active.set(chat,{child:p,started,stderr:''});const to=setTimeout(()=>{console.error(`[claude] timeout chat=${chat}`);p.kill('SIGTERM')},TIMEOUT);
  p.stdout.on('data',b=>{out+=b.toString();});
  p.stderr.on('data',b=>{const s=b.toString();err+=s;console.error(`[claude] ${s.trimEnd()}`);const a=active.get(chat);if(a)a.stderr=err.trim().split(/\r?\n/).at(-1)||''});
  p.on('error',e=>{clearTimeout(to);active.delete(chat);console.error(`[claude] spawn error: ${e.stack||e}`);reject(new Error(`Claude Code could not start: ${e.message}`))});
  p.on('close',(code,signal)=>{clearTimeout(to);active.delete(chat);console.log(`[claude] exited code=${code} signal=${signal} stdout=${out.length} stderr=${err.length}`);if(code===0)resolve(out.trim());else reject(new Error(`Claude Code exited code=${code} signal=${signal}\n${err.slice(-3000)||'No stderr output. Check TabiToken/model configuration and Claude Code startup.'}`))})
})}

const bot=new TelegramBot(TG,{polling:true});bot.on('polling_error',e=>console.error('Telegram:',e.message));
bot.onText(/^\/start$/,m=>{if(allowed(m))bot.sendMessage(m.chat.id,'🧠 Claude Code online. Send a task.\n/status — status\n/cancel — stop task')});
bot.onText(/^\/status$/,m=>{if(!allowed(m))return;const a=active.get(String(m.chat.id));bot.sendMessage(m.chat.id,a?`🛠️ Working ${Math.floor((Date.now()-a.started)/1000)}s\n${a.stderr||''}`:'✅ No active task.')});
bot.onText(/^\/cancel$/,m=>{if(!allowed(m))return;const a=active.get(String(m.chat.id));if(!a)return bot.sendMessage(m.chat.id,'ℹ️ No active task.');a.child.kill('SIGTERM');bot.sendMessage(m.chat.id,'🛑 Cancellation requested.')});
bot.on('message',async m=>{if(!m.text||m.text.startsWith('/')||!allowed(m))return;const chat=String(m.chat.id);if(active.has(chat))return bot.sendMessage(m.chat.id,'⏳ A task is already running. Use /cancel first.');const st=await bot.sendMessage(m.chat.id,'🧠 Claude Code starting…');const hb=setInterval(()=>{const a=active.get(chat);if(a)bot.editMessageText(`🧠 Claude Code working… ${Math.floor((Date.now()-a.started)/1000)}s\n${a.stderr||'Running tools / editing files…'}`,{chat_id:m.chat.id,message_id:st.message_id}).catch(()=>{})},5000);try{const out=await runClaude(m.text,chat);clearInterval(hb);await bot.editMessageText('✅ Done.',{chat_id:m.chat.id,message_id:st.message_id});await bot.sendMessage(m.chat.id,clip(out||'(No text output.)'))}catch(e){clearInterval(hb);await bot.editMessageText('❌ Claude Code failed.',{chat_id:m.chat.id,message_id:st.message_id});await bot.sendMessage(m.chat.id,clip(e?.message||e))}});
app.listen(PORT,'0.0.0.0',()=>console.log(`Listening ${PORT}; model=${MODEL}; TabiToken=${BASE}`));
