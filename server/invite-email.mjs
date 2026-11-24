export function createInviteMailer({apiKey,from,fetchImpl=globalThis.fetch}){
 if(!apiKey?.trim()||!from?.trim())return null;
 return async function sendInvite({email,url}){
  const response=await fetchImpl('https://api.resend.com/emails',{
   method:'POST',
   headers:{Authorization:`Bearer ${apiKey.trim()}`,'Content-Type':'application/json'},
   body:JSON.stringify({
    from:from.trim(),
    to:[email],
    subject:'Confirme sua conta na YENA',
    text:`Seu acesso à YENA foi liberado. Abra o link abaixo para confirmar sua conta e criar sua senha.\n\n${url}\n\nO link é de uso único e vale por 7 dias.`
   }),
   redirect:'error',
   signal:AbortSignal.timeout(10000)
  });
  await response.body?.cancel();
  if(!response.ok)throw new Error('O provedor recusou o e-mail de ativação.');
 };
}
