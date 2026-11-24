import http from 'node:http';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {AIError,DEFAULT_MODEL,completeWithDeepSeek,validateMessages} from './deepseek.mjs';
import {createMySQLRepository} from './database.mjs';
import {createAuth,hashClientPassword,inviteDigest} from './auth.mjs';
import {createInviteMailer} from './invite-email.mjs';
import {calculateQuote,validateClient} from '../dist/core.mjs';

const dist=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const assets=new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/app.mjs','app.mjs'],['/core.mjs','core.mjs'],['/portal.mjs','portal.mjs']]);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function readJSON(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new AIError(415,'invalid_type','Envie a mensagem no formato JSON.');
  if(Number(req.headers['content-length'])>65536)throw new AIError(413,'too_large','A mensagem excede o limite permitido.');
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>65536)throw new AIError(413,'too_large','A mensagem excede o limite permitido.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AIError(400,'invalid_json','Não foi possível ler a mensagem.');}
}
export function createYenaServer({apiKey=process.env.DEEPSEEK_API_KEY,model=process.env.DEEPSEEK_MODEL||DEFAULT_MODEL,fetchImpl=globalThis.fetch,timeoutMs=35000,rateLimit=10,now=Date.now,repository=createMySQLRepository(),adminUsername=process.env.YENA_ADMIN_USER||'admin',adminPassword=process.env.YENA_ADMIN_PASSWORD,publicOrigin=process.env.APP_ORIGIN||null,sendInvite=createInviteMailer({apiKey:process.env.RESEND_API_KEY,from:process.env.YENA_EMAIL_FROM})}={}){
  let calls=[],active=false;
  const activationAttempts=new Map();
  const quoteAttempts=new Map();
  function limitAttempt(attempts,key,limit){
    const time=now();
    for(const [address,entry] of attempts)if(entry.until<=time)attempts.delete(address);
    const attempt=attempts.get(key)||{count:0,until:time+60000};
    if(attempt.count>=limit)throw new AIError(429,'rate_limit','Aguarde um minuto antes de tentar novamente.');
    attempt.count++;attempts.set(key,attempt);
  }
  const auth=createAuth({username:adminUsername,password:adminPassword,now,findClient:repository?.findAccount?.bind(repository)});
  const publicURL=publicOrigin?new URL(publicOrigin):null;
  if(publicURL&&(publicURL.protocol!=='https:'||publicURL.pathname!=='/'||publicURL.search||publicURL.hash||publicURL.username||publicURL.password))throw new Error('APP_ORIGIN deve ser uma origem HTTPS sem caminho, parâmetros ou credenciais.');
  async function issueInvite(clientId,email,origin){
    const address=typeof email==='string'?email.trim().toLowerCase():'';
    if(address.length>120||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)||address===adminUsername.toLowerCase())throw new AIError(400,'invalid_email','Informe um e-mail válido para o cliente.');
    const token=randomBytes(32).toString('hex');
    if(!await repository.inviteClient(clientId,address,inviteDigest(token),now()+7*86400000))throw new AIError(409,'invite_conflict','Este cliente já tem uma conta ativa ou o e-mail está em uso.');
    return {email:address,url:origin+'/#convite/'+token};
  }
  async function emailInvite(clientId,contact){
    if(!publicURL||!sendInvite)throw new AIError(503,'email_not_configured','Configure o serviço de e-mail e o endereço público HTTPS da YENA.');
    const invite=await issueInvite(clientId,contact,publicURL.origin);
    try{await sendInvite(invite);}
    catch{throw new AIError(502,'email_failed','O envio do convite não foi confirmado. Tente novamente em Convites.');}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const allowedHosts=publicURL?[publicURL.host]:[`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`];
      if(!allowedHosts.includes(req.headers.host))throw new AIError(403,'invalid_host','Este servidor atende somente pelo endereço local.');
      const origin=publicURL?.origin||`http://${req.headers.host}`;
      const pathname=new URL(req.url,origin).pathname;
      if(!['GET','HEAD'].includes(req.method)&&(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'))throw new AIError(403,'invalid_origin','Abra a YENA pelo endereço deste servidor para continuar.');
      if(pathname==='/api/session'){
        if(req.method==='GET'){
          const user=auth.user(req);
          return json(res,200,{authenticated:!!user,user,accessConfigured:auth.configured,loginRequired:true});
        }
        if(req.method==='POST'){const result=await auth.login(req,await readJSON(req));if(result.error)throw new AIError(result.status,'login_failed',result.error);res.setHeader('Set-Cookie',auth.cookie(result.token,!!publicOrigin));return json(res,200,{user:result.user});}
        if(req.method==='DELETE'){auth.logout(req);res.setHeader('Set-Cookie',auth.cookie('',!!publicOrigin));return json(res,200,{success:true});}
        throw new AIError(405,'method_not_allowed','Método não permitido.');
      }
      if(pathname==='/api/activate'&&req.method==='POST'){
        if(!repository||!auth.configured)throw new AIError(503,'database_unavailable','A ativação está indisponível.');
        const time=now(),key=req.socket.remoteAddress;
        limitAttempt(activationAttempts,key,5);
        const {token,password}=await readJSON(req)||{};
        if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||typeof password!=='string'||password.length<12||password.length>256)throw new AIError(400,'invalid_fields','Confira o convite e use uma senha de 12 a 256 caracteres.');
        if(!await repository.activateClient(inviteDigest(token),hashClientPassword(password),time))throw new AIError(400,'invalid_invite','Convite inválido, expirado ou já utilizado.');
        activationAttempts.delete(key);
        return json(res,200,{success:true});
      }
      if(pathname==='/api/quote-request'&&req.method==='POST'){
        if(!repository?.requestQuote)throw new AIError(503,'database_unavailable','Solicitações indisponíveis neste momento.');
        limitAttempt(quoteAttempts,req.socket.remoteAddress,3);
        const input=await readJSON(req);
        let client,snapshot;
        try{
          client=validateClient({name:input?.name,institution:input?.institution,contact:input?.contact,need:'Solicitação de orçamento enviada pelo site.',stage:'Novo contato'});
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.contact))throw new Error('Informe um e-mail válido.');
          snapshot=calculateQuote(input);
        }catch(error){throw new AIError(400,'invalid_fields',error.message);}
        await repository.requestQuote(client,snapshot);
        return json(res,201,{success:true});
      }
      const user=auth.user(req);
      if(pathname.startsWith('/api/')){
        if(!auth.configured)throw new AIError(503,'access_not_configured','Configure o acesso administrativo no servidor para iniciar a plataforma.');
        if(!user)throw new AIError(401,'authentication_required','Entre com usuário e senha para acessar a plataforma.');
      }
      if(pathname==='/api/me'&&req.method==='GET'&&user?.role==='client'){
        const profile=await repository.clientProfile(user.clientId);
        if(!profile){auth.logout(req);throw new AIError(401,'authentication_required','A conta do cliente não está disponível.');}
        return json(res,200,{profile,quotes:await repository.listQuotes(user.clientId)});
      }
      if(pathname.startsWith('/api/')&&user?.role==='client')throw new AIError(403,'forbidden','Esta operação requer acesso administrativo.');
      if(pathname==='/api/invites'){
        if(!repository)throw new AIError(503,'database_unavailable','MySQL não configurado.');
        if(req.method==='GET')return json(res,200,{accounts:await repository.listAccounts()});
        if(['POST','PUT'].includes(req.method)){
          const {clientId,email,webcamEnabled,sendEmail}=await readJSON(req)||{};
          if(typeof clientId!=='string'||!/^[a-f0-9-]{36}$/i.test(clientId))throw new AIError(400,'invalid_client','Selecione um cliente válido.');
          if(req.method==='PUT'){
            if(typeof webcamEnabled!=='boolean')throw new AIError(400,'invalid_fields','Confira a permissão da webcam.');
            if(!await repository.setWebcam(clientId,webcamEnabled))throw new AIError(404,'not_found','Conta não encontrada.');
            return json(res,200,{success:true});
          }
          if(sendEmail===true){
            await emailInvite(clientId,await repository.clientContact(clientId));
            return json(res,201,{emailed:true});
          }
          const {url}=await issueInvite(clientId,email,origin);
          return json(res,201,{url});
        }
        throw new AIError(405,'method_not_allowed','Método não permitido.');
      }
      const quoteStatus=pathname.match(/^\/api\/quotes\/([a-f0-9-]{36})\/status$/i);
      if(quoteStatus&&req.method==='PUT'){
        if(!repository)throw new AIError(503,'database_unavailable','MySQL não configurado.');
        const {status}=await readJSON(req)||{};
        if(!['Em análise','Orçamento enviado','Aprovado'].includes(status))throw new AIError(400,'invalid_status','Selecione um status válido.');
        if(status==='Aprovado'){
          const approval=await repository.approveQuote(quoteStatus[1]);
          if(!approval)throw new AIError(404,'not_found','Orçamento não encontrado.');
          if(approval.changed&&approval.clientId&&!approval.active){
            try{
              await emailInvite(approval.clientId,approval.contact);
              return json(res,200,{success:true,inviteEmail:'sent'});
            }catch(error){
              const message=error instanceof AIError?error.message:'Não foi possível preparar o convite. Tente novamente em Convites.';
              return json(res,200,{success:true,inviteEmail:'failed',message});
            }
          }
          if(approval.changed&&!approval.clientId)return json(res,200,{success:true,inviteEmail:'skipped',message:'O orçamento aprovado está sem vínculo com um cliente.'});
          return json(res,200,{success:true});
        }
        if(!await repository.updateQuoteStatus(quoteStatus[1],status))throw new AIError(404,'not_found','Orçamento não encontrado.');
        return json(res,200,{success:true});
      }
      if(pathname==='/api/data/status'){
        if(req.method!=='GET')throw new AIError(405,'method_not_allowed','Método não permitido.');
        let ready=false;if(repository)try{ready=await repository.check();}catch{}
        return json(res,200,{configured:!!repository,ready,storage:'mysql',authenticated:!!user,user,accessConfigured:auth.configured});
      }
      if(/^\/api\/(clients|quotes)(?:\/|$)/.test(pathname)){
        if(!repository)throw new AIError(503,'database_not_configured','MySQL não configurado. Nenhum registro foi salvo no banco.');
        const [,resource,id]=pathname.match(/^\/api\/(clients|quotes)(?:\/([^/]+))?$/)||[];
        if(!resource||(id&&!/^[a-f0-9-]{36}$/i.test(id)))throw new AIError(404,'not_found','Registro não encontrado.');
        let input;
        if(['POST','PUT'].includes(req.method)){
          input=await readJSON(req);
          try{if(resource==='clients')input=validateClient(input);else{calculateQuote(input);if(input.clientId&&!/^[a-f0-9-]{36}$/i.test(input.clientId))throw new Error('Cliente inválido.');}}catch(error){throw new AIError(400,'invalid_fields',error.message);}
        }
        try{
          if(resource==='clients'){
            if(req.method==='GET'&&!id)return json(res,200,{clients:await repository.listClients()});
            if(req.method==='POST'&&!id)return json(res,201,{client:await repository.createClient(input)});
            if(req.method==='PUT'&&id){const client=await repository.updateClient(id,input);if(!client)throw new AIError(404,'not_found','Cliente não encontrado.');return json(res,200,{client});}
            if(req.method==='DELETE'&&id){if(!await repository.deleteClient(id))throw new AIError(404,'not_found','Cliente não encontrado.');return json(res,200,{success:true});}
          }else{
            if(req.method==='GET'&&!id)return json(res,200,{quotes:await repository.listQuotes()});
            if(req.method==='POST'&&!id)return json(res,201,{quote:await repository.createQuote(input)});
            if(req.method==='DELETE'&&id){if(!await repository.deleteQuote(id))throw new AIError(404,'not_found','Orçamento não encontrado.');return json(res,200,{success:true});}
          }
        }catch(error){if(error instanceof AIError)throw error;throw new AIError(503,'database_unavailable','Não foi possível concluir a operação no MySQL. Nenhuma confirmação de gravação foi recebida.');}
        throw new AIError(405,'method_not_allowed','Método não permitido.');
      }
      if(pathname==='/api/ai/status'){
        if(req.method!=='GET')throw new AIError(405,'method_not_allowed','Método não permitido.');
        return json(res,200,{configured:Boolean(apiKey?.trim()),provider:'deepseek',model});
      }
      if(pathname==='/api/ai/chat'){
        if(req.method!=='POST')throw new AIError(405,'method_not_allowed','Método não permitido.');
        const body=await readJSON(req);
        const messages=validateMessages(body?.messages);
        if(!apiKey?.trim())throw new AIError(503,'not_configured','DeepSeek não configurado. Configure DEEPSEEK_API_KEY no servidor.');
        calls=calls.filter(time=>now()-time<60000);
        if(active||calls.length>=rateLimit)throw new AIError(429,'local_rate_limit','Aguarde a consulta atual ou tente novamente em um minuto.');
        calls.push(now());active=true;
        try{return json(res,200,await completeWithDeepSeek({apiKey,model,messages,fetchImpl,timeoutMs}));}finally{active=false;}
      }
      if(!['GET','HEAD'].includes(req.method))throw new AIError(405,'method_not_allowed','Método não permitido.');
      const filename=assets.get(pathname);if(!filename)return json(res,404,{error:'not_found',message:'Página não encontrada.'});
      const contents=await fs.readFile(path.join(dist,filename));
      res.writeHead(200,{'Content-Type':mime[path.extname(filename)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
      res.end(req.method==='HEAD'?undefined:contents);
    }catch(error){
      if(error instanceof AIError)return json(res,error.status,{error:error.code,message:error.message});
      json(res,500,{error:'internal_error',message:'Não foi possível concluir a solicitação.'});
    }
  });
  server.requestTimeout=45000;server.headersTimeout=10000;
  return server;
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const port=Number(process.env.PORT||4173);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT deve ser um número inteiro entre 1 e 65535.');
  const server=createYenaServer();
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'A porta está em uso. Feche a outra instância ou escolha outra PORT.':'Não foi possível iniciar o servidor local.');process.exitCode=1;});
  if(process.env.HOST&&process.env.HOST!=='127.0.0.1'&&!process.env.APP_ORIGIN)throw new Error('Defina APP_ORIGIN HTTPS antes de expor o servidor.');
  server.listen(port,process.env.HOST||'127.0.0.1',()=>{console.log(`YENA: ${process.env.APP_ORIGIN||`http://127.0.0.1:${port}`}`);console.log(process.env.DEEPSEEK_API_KEY?.trim()?'DeepSeek configurado. A credencial será verificada na primeira consulta.':'Modo demonstração. DEEPSEEK_API_KEY não configurada.');});
  const shutdown=()=>{server.close();server.closeAllConnections();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
