import {calculateQuote,escapeHtml as esc,money,PLANS} from './core.mjs';

export const clientRoutes=[
 ['meus-orcamentos','Meus orçamentos','document'],
 ['meu-monitoramento','Meu monitoramento','camera'],
 ['minha-conta','Minha conta','users']
];
export const quoteStatuses=['Em análise','Orçamento enviado','Aprovado'];
export const inviteToken=()=>location.hash.match(/^#convite\/([a-f0-9]{64})$/)?.[1];

export function receptionPanel(){
 return `<section class="panel reception-panel" aria-labelledby="reception-title">
  <div class="motion-heading"><div><h2 id="reception-title">Recepção</h2><p>Veja como um evento aparece no monitoramento de uma clínica fictícia.</p></div><span class="motion-tag">Simulação</span></div>
  <div class="reception-scene" role="img" aria-label="Recepção fictícia de uma clínica com um balcão e uma entrada monitorada">
   <div class="reception-floor"></div>
   <div class="reception-sign">YENA <small>RECEPÇÃO</small></div>
   <div class="reception-door"></div>
   <div class="reception-desk"></div>
   <div class="reception-plant"></div>
   <div class="reception-entry"><span>Entrada monitorada</span></div>
   <div class="reception-person"></div>
  </div>
  <div class="public-actions"><button class="button" type="button" data-action="simulate-motion">Simular movimento</button></div>
  <div class="motion-events"><h3>Alertas da recepção</h3><p data-motion-empty>Nenhum evento simulado nesta sessão.</p><ol data-motion-log aria-live="polite" aria-relevant="additions"></ol></div>
 </section>`;
}

function addMotionEvent(panel,label){
 const log=panel.querySelector('[data-motion-log]');
 const entry=document.createElement('li');
 const message=document.createElement('span');
 const timestamp=document.createElement('time');
 const now=new Date();
 message.textContent=label;
 timestamp.dateTime=now.toISOString();
 timestamp.textContent=now.toLocaleTimeString('pt-BR');
 entry.append(message,timestamp);
 panel.querySelector('[data-motion-empty]').hidden=true;
 log.prepend(entry);
 if(log.children.length>10)log.lastElementChild.remove();
}

export function simulateMotion(button){
 const panel=button.closest('.reception-panel'),scene=panel.querySelector('.reception-scene');
 button.disabled=true;
 scene.classList.remove('motion-detected');
 const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches||document.body.classList.contains('no-motion');
 const person=panel.querySelector('.reception-person');
 const animation=reducedMotion?null:person.animate([
  {left:'85%',opacity:0},{left:'78%',opacity:1,offset:.22},{left:'60%',opacity:1,offset:.8},{left:'54%',opacity:0}
 ],{duration:1200,easing:'linear'});
 scene.classList.add('motion-detected');
 addMotionEvent(panel,'Movimento na recepção');
 if(animation)animation.finished.then(()=>{button.disabled=false;},()=>{button.disabled=false;});
 else button.disabled=false;
}

export function webcamPanel(){
 return `<section class="panel webcam-panel"><div class="motion-heading"><div><h2>Teste ao vivo</h2><p>Use a webcam deste dispositivo para detectar movimento. A análise acontece no navegador, sem áudio ou gravação.</p></div></div>
  <div id="webcam-feed" class="webcam-feed" hidden><video id="live-webcam" autoplay muted playsinline aria-label="Vídeo ao vivo da webcam"></video><div class="webcam-region" aria-hidden="true"></div></div>
  <p id="webcam-instructions" hidden>Arraste sobre o vídeo para marcar uma região ou use a imagem inteira. Depois, passe na frente da câmera.</p>
  <div class="public-actions"><button class="button" type="button" data-action="webcam-start">Ligar webcam</button><button class="button secondary" type="button" data-action="webcam-stop" hidden>Desligar webcam</button><button class="button secondary" type="button" data-action="webcam-full" hidden>Usar imagem inteira</button></div>
  <p id="webcam-status" role="status" hidden></p>
  <div class="motion-events"><h3>Alertas do teste ao vivo</h3><p data-motion-empty>Nenhum movimento detectado.</p><ol data-motion-log aria-live="polite" aria-relevant="additions"></ol></div>
 </section>`;
}

const fullFrame={x:0,y:0,width:1,height:1};
let webcamStream=null,webcamVersion=0,motionTimer,regionListeners;
export function stopWebcam(){
 webcamVersion++;
 clearInterval(motionTimer);
 regionListeners?.abort();
 webcamStream?.getTracks().forEach(track=>track.stop());
 webcamStream=null;
 const video=document.querySelector('#live-webcam');
 if(!video)return;
 video.srcObject=null;
 document.querySelector('#webcam-feed').hidden=true;
 document.querySelector('#webcam-instructions').hidden=true;
 document.querySelector('[data-action="webcam-full"]').hidden=true;
 document.querySelector('[data-action="webcam-start"]').disabled=false;
 document.querySelector('[data-action="webcam-stop"]').hidden=true;
 const status=document.querySelector('#webcam-status');
 status.hidden=true;
 status.textContent='';
}

function watchMotion(video){
 const feed=video.parentElement,panel=feed.closest('.webcam-panel');
 const overlay=feed.querySelector('.webcam-region'),status=panel.querySelector('#webcam-status');
 const reset=panel.querySelector('[data-action="webcam-full"]');
 const sample=document.createElement('canvas');
 sample.width=96;sample.height=54;
 const context=sample.getContext('2d',{willReadFrequently:true});
 let region=fullFrame,drag=null,previous=null,streak=0,lastAlert=-Infinity;
 regionListeners=new AbortController();
 const options={signal:regionListeners.signal};
 function display(rect){
  Object.assign(overlay.style,{left:rect.x*100+'%',top:rect.y*100+'%',width:rect.width*100+'%',height:rect.height*100+'%'});
 }
 function select(rect,message){
  region=rect;previous=null;streak=0;lastAlert=-Infinity;
  display(region);feed.classList.remove('motion-detected');
  status.textContent=message;
 }
 function point(event){
  const bounds=feed.getBoundingClientRect(),clamp=value=>Math.min(1,Math.max(0,value));
  return {x:clamp((event.clientX-bounds.left)/bounds.width),y:clamp((event.clientY-bounds.top)/bounds.height)};
 }
 function rectangle(a,b){return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};}
 feed.addEventListener('pointerdown',event=>{
  if(!event.isPrimary||event.button!==0)return;
  drag={id:event.pointerId,start:point(event)};feed.setPointerCapture(event.pointerId);
 },options);
 feed.addEventListener('pointermove',event=>{if(drag?.id===event.pointerId)display(rectangle(drag.start,point(event)));},options);
 feed.addEventListener('pointerup',event=>{
  if(drag?.id!==event.pointerId)return;
  const rect=rectangle(drag.start,point(event));drag=null;
  if(rect.width>=.04&&rect.height>=.04)select(rect,'Monitorando a região marcada.');
  else display(region);
 },options);
 feed.addEventListener('lostpointercapture',()=>{
  if(!drag)return;
  drag=null;display(region);
 },options);
 reset.addEventListener('click',()=>select(fullFrame,'Monitorando a imagem inteira.'),options);
 select(fullFrame,'Monitorando a imagem inteira.');
 motionTimer=setInterval(()=>{
  if(drag||video.readyState<2||document.hidden)return;
  const {x,y,width,height}=region;
  const {videoWidth,videoHeight}=video;
  if(!videoWidth||!videoHeight)return;
  context.drawImage(video,x*videoWidth,y*videoHeight,width*videoWidth,height*videoHeight,0,0,sample.width,sample.height);
  const pixels=context.getImageData(0,0,sample.width,sample.height).data;
  const frame=new Uint8Array(sample.width*sample.height);
  let changed=0;
  for(let i=0;i<frame.length;i++){
   const channel=i*4;
   frame[i]=(77*pixels[channel]+150*pixels[channel+1]+29*pixels[channel+2])>>8;
   if(previous&&Math.abs(frame[i]-previous[i])>=24)changed++;
  }
  previous=frame;
  streak=changed>=frame.length*.025?streak+1:0;
  const now=performance.now();
  if(streak>=2&&now-lastAlert>=2400){
   lastAlert=now;
   addMotionEvent(panel,'Movimento detectado');
   status.textContent='Movimento detectado na região monitorada.';
   feed.classList.add('motion-detected');
  }else if(now-lastAlert>=2400&&feed.classList.contains('motion-detected')){
   feed.classList.remove('motion-detected');
   status.textContent=region===fullFrame?'Monitorando a imagem inteira.':'Monitorando a região marcada.';
  }
 },125);
}

export async function startWebcam(button){
 const video=document.querySelector('#live-webcam'),status=document.querySelector('#webcam-status');
 const stop=document.querySelector('[data-action="webcam-stop"]');
 const version=++webcamVersion;
 button.disabled=true;
 stop.hidden=false;
 status.textContent='Aguardando a permissão do navegador…';
 status.hidden=false;
 try{
  if(!navigator.mediaDevices?.getUserMedia)throw new Error();
  const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
  if(version!==webcamVersion||!video.isConnected){stream.getTracks().forEach(track=>track.stop());return;}
  webcamStream=stream;
  video.srcObject=stream;
  document.querySelector('#webcam-feed').hidden=false;
  document.querySelector('#webcam-instructions').hidden=false;
  document.querySelector('[data-action="webcam-full"]').hidden=false;
  watchMotion(video);
  stream.getVideoTracks()[0].addEventListener('ended',()=>{
   if(version!==webcamVersion)return;
   stopWebcam();status.textContent='A webcam foi desconectada.';status.hidden=false;
  });
 }catch{
  if(version!==webcamVersion)return;
  stopWebcam();
  status.textContent='Não foi possível abrir a webcam. Confira a conexão e a permissão no navegador.';
  status.hidden=false;
 }
}

export function customerPage(route,data,error){
 if(error)return `<p class="error" role="alert">${esc(error)}</p><button class="button" data-action="client-portal-retry">Tentar novamente</button>`;
 if(!data)return '<p role="status">Carregando sua área…</p>';
 const {profile,quotes}=data;
 if(route==='minha-conta')return `<div class="page-heading"><div><h1>Minha conta</h1></div></div><section class="panel settings-card"><h2>${esc(profile.name)}</h2><dl class="portal-details"><dt>E-mail</dt><dd>${esc(profile.email)}</dd><dt>Instituição</dt><dd>${esc(profile.institution)}</dd></dl></section>`;
 if(route==='meu-monitoramento')return `<div class="page-heading"><div><h1>Meu monitoramento</h1></div></div>${receptionPanel()}${profile.webcamEnabled?webcamPanel():'<p class="notice">O administrador pode habilitar o teste ao vivo para sua conta.</p>'}`;
 return `<div class="page-heading"><div><h1>Olá, ${esc(profile.name.trim().split(/\s+/)[0])}!</h1><p>Acompanhe os orçamentos vinculados à sua conta.</p></div></div><section class="panel"><div class="panel-heading"><h2>Meus orçamentos</h2></div>${quotes.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Plano</th><th>Investimento inicial</th><th>Mensalidade</th><th>Status</th></tr></thead><tbody>${quotes.map(({snapshot:q})=>`<tr><td><strong>${esc(PLANS[q.plan]?.name||q.plan)}</strong></td><td>${money(q.initial)}</td><td>${money(q.monthly)}</td><td>${esc(q.status||'Em análise')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty">Você ainda não tem orçamentos vinculados à sua conta.</p>'}</section>`;
}

export function invitesPage(clients,accounts,error){
 if(error)return `<div class="page-heading"><h1>Convites</h1></div><p class="error" role="alert">${esc(error)}</p><button class="button" data-action="invites-retry">Tentar novamente</button>`;
 if(!accounts)return '<div class="page-heading"><h1>Convites</h1></div><p role="status">Carregando contas…</p>';
 const accountsByClient=new Map(accounts.map(account=>[account.clientId,account]));
 const rows=clients.map(client=>{
  const account=accountsByClient.get(client.id);
  return `<tr><td><strong>${esc(client.name)}</strong><small>${esc(client.institution)}</small></td><td>${esc(account?.email||'')}</td><td>${account?.active?'Conta ativa':!account?'Sem convite':Number(account.expires)>Date.now()?'Aguardando ativação':'Convite expirado'}</td><td>${account?.active?'':`<button class="button secondary" data-action="invite-create" data-id="${esc(client.id)}">${account?'Gerar novo convite':'Gerar convite'}</button>`}</td><td>${account?`<button class="button secondary" data-action="invite-webcam" data-id="${esc(client.id)}" aria-pressed="${Boolean(account.webcamEnabled)}">${account.webcamEnabled?'Desabilitar webcam':'Habilitar webcam'}</button>`:''}</td></tr>`;
 }).join('');
 return `<div class="page-heading"><div><h1>Convites</h1><p>Gere um link de uso único para o cliente criar sua senha. O link vale por 7 dias.</p></div></div><section class="panel">${rows?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Cliente</th><th>E-mail</th><th>Acesso</th><th>Convite</th><th>Webcam local</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="empty">Cadastre um cliente para gerar o primeiro convite.</p>'}</section>`;
}

export function setupPublicQuote(api){
 const form=document.querySelector('#public-quote-form'),output=document.querySelector('#public-estimate');
 const status=document.querySelector('#public-quote-status'),button=form.querySelector('button');
 function payload(){
  const fields=new FormData(form);
  return {name:fields.get('name'),institution:fields.get('institution'),contact:fields.get('contact'),plan:fields.get('plan'),cameras:Number(fields.get('cameras')),badges:Number(fields.get('badges')),installation:fields.has('installation'),maintenance:fields.has('maintenance')};
 }
 function update(){
  if(!form.elements.cameras.validity.valid||!form.elements.badges.validity.valid){output.textContent='Confira as quantidades.';return;}
  const quote=calculateQuote(payload());
  output.textContent=`Investimento inicial ${money(quote.initial)} · Mensalidade ${money(quote.monthly)}`;
 }
 form.addEventListener('input',update);
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  status.hidden=false;
  if(location.protocol==='file:'){
   status.textContent='Abra a YENA pelo servidor local para enviar a solicitação.';
   return;
  }
  button.disabled=true;
  status.textContent='Enviando solicitação…';
  try{
   await api('/api/quote-request',{method:'POST',body:JSON.stringify(payload())});
   status.textContent='Solicitação enviada para a equipe YENA.';
   form.reset();update();
  }catch(error){status.textContent=error.message;}
  finally{button.disabled=false;}
 });
 update();
}
