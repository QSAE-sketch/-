'use strict';
const https=require('https'), crypto=require('crypto');
const BASE='https://qingliao-chat-33476.app.workbuddy.host'; const COOKIES={};
function req(method,path,body,token){return new Promise((res,rej)=>{const data=body==null?null:Buffer.from(JSON.stringify(body),'utf8');const h={};if(token)h['X-Token']=token;if(data)h['Content-Type']='application/json; charset=utf-8';const ck=Object.keys(COOKIES).map(k=>k+'='+COOKIES[k]).join('; ');if(ck)h['Cookie']=ck;const u=new URL(path,BASE);const r=https.request({hostname:u.hostname,port:443,path:u.pathname+u.search,method,headers:h},rs=>{for(const l of (rs.headers['set-cookie']||[])){const kv=l.split(';')[0];const i=kv.indexOf('=');if(i>0)COOKIES[kv.slice(0,i).trim()]=kv.slice(i+1).trim();}const cs=[];rs.on('data',c=>cs.push(c));rs.on('end',()=>{let j=null;try{j=JSON.parse(Buffer.concat(cs).toString('utf8'));}catch(e){}res({status:rs.statusCode,json:j});});});r.on('error',rej);if(data)r.write(data);r.end();});}
(async()=>{
  await req('GET','/?sharecode=T7ELJZOC5A');
  let r=await req('POST','/api/login',{username:'qa2411',password:'[已隐去]'}); const A=r.json.token;
  const me=await req('GET','/api/me',null,A); const aid=me.json.user.id;
  const cn='qc'+crypto.randomBytes(3).toString('hex');
  r=await req('POST','/api/register',{username:cn,password:'pass123',nickname:'周慕云'}); const C=r.json.token;
  r=await req('POST','/api/friends/request',{userId:aid,message:'加个好友吧，我是隔壁组的周慕云。'},C);
  console.log('新申请 id =', r.json.request.id, ' 申请人 =', cn);
})().catch(e=>{console.error(e);process.exit(1);});
