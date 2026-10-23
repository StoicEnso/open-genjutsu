/** Offline billing/security protocol tests. Every external request uses a fake transport. */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Cloud, CLOUD_MODEL, cloudStorageUrl, type CloudCredentialStore } from '../server/cloud.js';
import { Media, discoverMediaBinaries } from '../server/media.js';
import { Store } from '../server/storage.js';
import { startServer } from '../server/app.js';
import type { CloudInput, CloudJob } from '../shared/types.js';
const exec=promisify(execFile);
const KEY='comfyui-offline-test-secret-do-not-use';
let fixtures:string;let bytes:Buffer;
before(async()=>{fixtures=await mkdtemp(path.join(tmpdir(),'open-genjutsu-cloud-fixtures-'));const tools=await discoverMediaBinaries();assert.ok(tools.available&&tools.ffmpeg.path);await exec(tools.ffmpeg.path,['-y','-v','error','-f','lavfi','-i','color=green:s=64x64','-frames:v','1',path.join(fixtures,'reference.png')]);await exec(tools.ffmpeg.path,['-y','-v','error','-f','lavfi','-i','color=blue:s=64x64:r=24','-t','4.5','-c:v','libx264','-pix_fmt','yuv420p',path.join(fixtures,'video.mp4')]);bytes=await readFile(path.join(fixtures,'video.mp4'));});
after(async()=>{await rm(fixtures,{recursive:true,force:true});});
function mock(){
 const calls:{method:string;url:string;auth:string|null;body?:unknown}[]=[];let amount='1.25';let hold=false;let lost=false;let submits=0;let cancels=0;let polls=0;let release:undefined|(()=>void);let blockUpload=false;
 const requestId=randomUUID();const json=(b:unknown,status=200)=>new Response(JSON.stringify(b),{status,headers:{'content-type':'application/json'}});
 const transport:typeof fetch=async(input,init)=>{
  const u=new URL(input instanceof Request?input.url:String(input));const method=init?.method||'GET';const headers=new Headers(init?.headers);calls.push({method,url:u.href,auth:headers.get('authorization')||headers.get('x-api-key')});
  assert.ok(['cloud.comfy.org','api.comfy.org','storage.googleapis.com'].includes(u.hostname),'only fixed hosts used');
  if(u.hostname==='cloud.comfy.org'){
   assert.equal(headers.get('authorization'),`Bearer ${KEY}`);
   if(u.pathname.includes('/by-hash/'))return new Response(null,{status:404});
   if(u.pathname==='/api/v2/assets'&&method==='POST'){
    assert.ok(init?.body instanceof FormData,'realSDK must upload multipart');
    if(blockUpload)await new Promise<void>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error(KEY)),{once:true});});
    const form=init!.body as FormData;const blob=form.get('file') as Blob;const id=randomUUID();return json({id,hash:form.get('expected_hash'),content_type:form.get('content_type'),file_path:form.get('file_path'),size_bytes:blob.size,created_new:true,created_at:new Date().toISOString(),url:`/api/v2/assets/${id}/content`,url_expires_at:new Date(Date.now()+3600000).toISOString()},201);
   }
   if(/\/assets\/[^/]+\/content$/.test(u.pathname))return new Response(null,{status:302,headers:{Location:`https://storage.googleapis.com/comfy-offline/input-${randomUUID()}?signed=private-upload-token`}});
  }
  if(u.hostname==='api.comfy.org'){
   assert.equal(headers.get('x-api-key'),KEY);if(method==='POST')assert.equal(u.searchParams.get('fallback_provider'),'false');
   if(u.pathname.endsWith('/estimate')){
    const body=JSON.parse(String(init?.body));calls.at(-1)!.body=body;assert.equal(body.generate_audio,false);assert.equal(body.content[1].role,'reference_image');assert.equal(body.content[2].role,'reference_video');return json({currency:'USD',amount,model:CLOUD_MODEL});
   }
   if(u.pathname.endsWith('/requests')&&method==='POST'){
    submits++;assert.ok(headers.get('idempotency-key'));if(lost)throw new Error(`lost response ${KEY}`);if(hold)await new Promise<void>(resolve=>{release=resolve;});return json({request_id:requestId,status:'IN_QUEUE',status_url:'https://evil.invalid/do-not-follow'},201);
   }
   if(u.pathname.endsWith('/cancel')){cancels++;return json({status:'CANCELLATION_REQUESTED'},202);}
   if(u.pathname.endsWith('/status')){polls++;return json(cancels?{status:'COMPLETED',error_type:'cancelled'}:hold?{status:'IN_PROGRESS'}:{status:'COMPLETED'});}
   if(u.pathname.endsWith(`/requests/${requestId}`))return json({status:'succeeded',content:{video_url:'https://storage.googleapis.com/comfy-offline/output.mp4?secret=result-token'}});
  }
  if(u.hostname==='storage.googleapis.com'){
   assert.equal(headers.get('authorization'),null);assert.equal(headers.get('x-api-key'),null);assert.equal(init?.redirect,'manual');return new Response(bytes as BodyInit,{headers:{'content-type':'video/mp4','content-length':String(bytes.length)}});
  }
  throw new Error('Unexpected fake protocol route');
 };
 return{transport,calls,get submits(){return submits;},get cancels(){return cancels;},get polls(){return polls;},setAmount:(n:string)=>{amount=n;},setHold:(v:boolean)=>{hold=v;},setLost:()=>{lost=true;},release:()=>{release?.();},blockUpload:()=>{blockUpload=true;}};
}
async function setup(credentials?:CloudCredentialStore){
 const dir=await mkdtemp(path.join(tmpdir(),'open-genjutsu-cloud-'));const store=new Store(dir);await store.init();const media=new Media(store);
 const tmpRef=path.join(store.tempDir,randomUUID()+'.part');const tmpVideo=path.join(store.tempDir,randomUUID()+'.part');await copyFile(path.join(fixtures,'reference.png'),tmpRef);await copyFile(path.join(fixtures,'video.mp4'),tmpVideo);
 const reference=await media.adopt(tmpRef,'reference.png','image');const source=await media.adopt(tmpVideo,'driver.mp4','video');const fake=mock();const cloud=new Cloud(store,media,fake.transport,credentials,1);await cloud.init();
 const input:CloudInput={sourceVideoId:source.asset.id,referenceImageId:reference.asset.id,prompt:'Use the reference character and follow the source head movement.',duration:4,resolution:'480p',ratio:'1:1'};
 return{dir,store,media,fake,cloud,input,cleanup:async()=>{await cloud.close();await rm(dir,{recursive:true,force:true});}};
}
async function until(cloud:Cloud,id:string,predicate:(job:CloudJob)=>boolean):Promise<CloudJob>{for(let n=0;n<150;n++){const j=cloud.get(id);if(predicate(j))return j;await new Promise(r=>setTimeout(r,10));}throw new Error('mock job did not finish');}
async function waitFor(predicate:()=>boolean){for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('mock checkpoint absent');}
test('realSDK uploads+manual signedURL; quote is non-generating, single-use, bound; result persists without exported secrets',async()=>{
 const f=await setup();try{
  await f.cloud.setKey({apiKey:KEY});await assert.rejects(f.cloud.quote({...f.input,uploadConsent:false}));assert.equal(f.fake.calls.length,0);
  const q=await f.cloud.quote({...f.input,uploadConsent:true});assert.equal(q.amount,'1.25');assert.equal(f.fake.submits,0);assert.ok(!JSON.stringify(q).includes('private-upload-token'));assert.ok(!JSON.stringify(q).includes(KEY));
  await assert.rejects(f.cloud.create({quoteId:q.id,consent:false}));
  const results=await Promise.allSettled([f.cloud.create({quoteId:q.id,consent:true}),f.cloud.create({quoteId:q.id,consent:true})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const job=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<CloudJob>).value;const done=await until(f.cloud,job.id,j=>['succeeded','failed','interrupted'].includes(j.status));assert.equal(done.status,'succeeded',done.message);assert.equal(f.fake.submits,1);assert.equal(done.outputs.length,1);
  const exported=JSON.stringify([f.cloud.list(),f.cloud.manifest(job.id)]);for(const secret of [KEY,'private-upload-token','result-token','https://storage.googleapis.com'])assert.ok(!exported.includes(secret));assert.equal((await readFile(f.store.snapshot().assets[done.outputs[0]!.id]!.filename)).length,bytes.length);
  const persisted=await readFile(path.join(f.dir,'cloud-state.json'),'utf8');assert.ok(!persisted.includes(KEY));assert.equal(f.fake.calls.filter(c=>c.method==='POST'&&c.url.includes('/api/v2/assets')).length,2);
 }finally{await f.cleanup();}
});
test('a higher estimate blocks submission and spent quote cannot be reused',async()=>{const f=await setup();try{await f.cloud.setKey({apiKey:KEY});const q=await f.cloud.quote({...f.input,uploadConsent:true});f.fake.setAmount('1.30');const j=await f.cloud.create({quoteId:q.id,consent:true});const end=await until(f.cloud,j.id,j=>j.status==='failed');assert.match(end.error||'',/estimate increased/);assert.equal(f.fake.submits,0);await assert.rejects(f.cloud.create({quoteId:q.id,consent:true}));}finally{await f.cleanup();}});
test('cancel during submit is sent once as soon as receipt arrives',async()=>{const f=await setup();try{await f.cloud.setKey({apiKey:KEY});const q=await f.cloud.quote({...f.input,uploadConsent:true});f.fake.setHold(true);const j=await f.cloud.create({quoteId:q.id,consent:true});await waitFor(()=>f.fake.submits===1);await f.cloud.cancel(j.id);assert.equal(f.fake.cancels,0);f.fake.release();await until(f.cloud,j.id,j=>j.status==='cancelled');assert.equal(f.fake.cancels,1);assert.equal(f.fake.submits,1);}finally{await f.cleanup();}});
test('ambiguous acceptance is never resubmitted and cannot be blindly resumed',async()=>{const f=await setup();try{await f.cloud.setKey({apiKey:KEY});const q=await f.cloud.quote({...f.input,uploadConsent:true});f.fake.setLost();const j=await f.cloud.create({quoteId:q.id,consent:true});const end=await until(f.cloud,j.id,j=>j.status==='interrupted');assert.equal(end.requestId,undefined);assert.ok(!JSON.stringify(end).includes(KEY));await assert.rejects(f.cloud.resume(j.id));assert.equal(f.fake.submits,1);}finally{await f.cleanup();}});
test('restart recovers saved receipt with GET only, never a second paid submit',async()=>{
 let saved:string|undefined=KEY;const credentials={read:async()=>saved,write:async(s:string)=>{saved=s;},clear:async()=>{saved=undefined;}};const f=await setup(credentials);
 try{const q=await f.cloud.quote({...f.input,uploadConsent:true});f.fake.setHold(true);const j=await f.cloud.create({quoteId:q.id,consent:true});await waitFor(()=>f.fake.submits===1);f.fake.release();await waitFor(()=>!!f.cloud.get(j.id).requestId);await f.cloud.close();const resumed=new Cloud(f.store,f.media,f.fake.transport,credentials,1);await resumed.init();assert.equal(resumed.get(j.id).status,'interrupted');f.fake.setHold(false);await resumed.resume(j.id);assert.equal((await until(resumed,j.id,j=>j.status==='succeeded')).status,'succeeded');assert.equal(f.fake.submits,1);await resumed.close();}finally{await f.cleanup();}
});
test('close aborts+awaits a quote upload; no late quote or generation survives',async()=>{const f=await setup();try{await f.cloud.setKey({apiKey:KEY});f.fake.blockUpload();const pending=f.cloud.quote({...f.input,uploadConsent:true}).then(()=>null,e=>e);await waitFor(()=>f.fake.calls.some(c=>c.method==='POST'&&c.url.includes('/api/v2/assets')));await f.cloud.close();const e=await pending;assert.ok(e instanceof Error);assert.ok(!e.message.includes(KEY));assert.equal(f.fake.submits,0);assert.equal(f.cloud.status().keyConfigured,false);}finally{await f.cleanup();}});
test('saved-key failure does not prevent local startup; no plaintext persistence fallback',async()=>{const f=await setup({read:async()=>{throw new Error(KEY);},write:async()=>{throw new Error(KEY);},clear:async()=>{}});try{assert.equal(f.cloud.status().keyConfigured,false);assert.ok(f.cloud.status().warnings.some(w=>w.includes('saved key')));await assert.rejects(f.cloud.setKey({apiKey:KEY,remember:true}),e=>e instanceof Error&&!e.message.includes(KEY));await f.cloud.setKey({apiKey:KEY});assert.equal(f.cloud.status().storage,'session');await f.cloud.clearKey();assert.equal(f.cloud.status().keyConfigured,false);}finally{await f.cleanup();}});
test('media host allowlist refuses redirects, local hosts and credential-bearing URLs',()=>{for(const url of ['http://storage.googleapis.com/a','https://127.0.0.1/a','https://storage.googleapis.com.evil.invalid/a','https://user:secret@storage.googleapis.com/a','https://storage.googleapis.com:4433/a'])assert.throws(()=>cloudStorageUrl(url));assert.equal(cloudStorageUrl('https://storage.googleapis.com/comfy/a?signature=offline').hostname,'storage.googleapis.com');});
test('HTTP key/parser errors do not echo secret; health declares optional cloud while local settings remain keyless',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'open-genjutsu-cloud-http-'));await mkdir(path.join(dir,'packs'));const fake=mock();const instance=await startServer({dataDir:path.join(dir,'data'),workflowsDir:path.join(dir,'packs'),port:0,cloudTransport:fake.transport});
 try{const base=`http://127.0.0.1:${instance.port}`;const health=await(await fetch(base+'/api/health')).json();assert.equal(health.mode,'local-first-optional-cloud');for(const body of [JSON.stringify({apiKey:KEY,extra:KEY}),'{"apiKey":"'+KEY+'",']){const res=await fetch(base+'/api/cloud/key',{method:'PUT',headers:{'content-type':'application/json'},body});assert.equal(res.status,400);assert.ok(!(await res.text()).includes(KEY));}const status=await(await fetch(base+'/api/cloud/status')).json();assert.equal(status.keyConfigured,false);assert.equal(fake.calls.length,0);assert.ok(!JSON.stringify(await(await fetch(base+'/api/settings')).json()).includes(KEY));}finally{await instance.close();await rm(dir,{recursive:true,force:true});}
});

test('unreadable optional history is preserved and local HTTP app still starts',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'open-genjutsu-cloud-badstate-'));await mkdir(path.join(dir,'packs'));await mkdir(path.join(dir,'data'));const invalid='not valid JSON; preserve this evidence';await writeFile(path.join(dir,'data/cloud-state.json'),invalid);const fake=mock();const instance=await startServer({dataDir:path.join(dir,'data'),workflowsDir:path.join(dir,'packs'),port:0,cloudTransport:fake.transport});
 try{const base=`http://127.0.0.1:${instance.port}`;assert.equal((await fetch(base+'/api/health')).status,200);const status=await(await fetch(base+'/api/cloud/status')).json();assert.ok(status.warnings.some((w:string)=>w.includes('history is unreadable')));assert.equal(await readFile(path.join(dir,'data/cloud-state.json'),'utf8'),invalid);assert.equal(fake.calls.length,0);}finally{await instance.close();await rm(dir,{recursive:true,force:true});}
});

test('HTTP shutdown aborts active cloud quote before waiting for handlers to drain',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'open-genjutsu-cloud-shutdown-'));await mkdir(path.join(dir,'packs'));const fake=mock();fake.blockUpload();const instance=await startServer({dataDir:path.join(dir,'data'),workflowsDir:path.join(dir,'packs'),port:0,cloudTransport:fake.transport});
 try{
  const {store,media}=instance.app.locals.services as {store:Store;media:Media};
  const tmpRef=path.join(store.tempDir,randomUUID()+'.part');const tmpVideo=path.join(store.tempDir,randomUUID()+'.part');await copyFile(path.join(fixtures,'reference.png'),tmpRef);await copyFile(path.join(fixtures,'video.mp4'),tmpVideo);
  const reference=await media.adopt(tmpRef,'reference.png','image');const source=await media.adopt(tmpVideo,'source.mp4','video');const base=`http://127.0.0.1:${instance.port}`;
  await fetch(base+'/api/cloud/key',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({apiKey:KEY})});
  const pending=fetch(base+'/api/cloud/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceVideoId:source.asset.id,referenceImageId:reference.asset.id,prompt:'Follow the source movement.',duration:4,resolution:'480p',ratio:'1:1',uploadConsent:true})}).then(async r=>({status:r.status,text:await r.text()}));
  await waitFor(()=>fake.calls.some(c=>c.method==='POST'&&c.url.includes('/api/v2/assets')));
  const closing=instance.close();
  const response=await Promise.race([pending,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('shutdown failed to abort quote handler')),2000).unref())]);
  await closing;assert.ok(response.status>=400);assert.ok(!response.text.includes(KEY));assert.equal(fake.submits,0);
 }finally{await instance.close();await rm(dir,{recursive:true,force:true});}
});
