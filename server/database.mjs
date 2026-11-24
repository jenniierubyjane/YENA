import mysql from 'mysql2/promise';
import {randomUUID} from 'node:crypto';
import {calculateQuote,validateClient} from '../dist/core.mjs';
export function createMySQLRepository(env=process.env){
 if(!env.MYSQL_HOST||!env.MYSQL_USER||!env.MYSQL_DATABASE)return null;
 const pool=mysql.createPool({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT||3306),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD||'',database:env.MYSQL_DATABASE,waitForConnections:true,connectionLimit:5,queueLimit:20,connectTimeout:5000,charset:'utf8mb4',multipleStatements:false,...(env.MYSQL_SSL==='true'?{ssl:{rejectUnauthorized:true}}:{})});
 return new MySQLRepository(pool);
}
export class MySQLRepository {
 constructor(pool){this.pool=pool;}
 async check(){await this.pool.execute('SELECT id FROM clients LIMIT 0');await this.pool.execute('SELECT id FROM quotes LIMIT 0');return true;}
 async listClients(){const [rows]=await this.pool.execute('SELECT id, name, institution, contact, need, stage FROM clients ORDER BY created_at DESC, id');return rows;}
 async createClient(input){const c=validateClient(input),id=randomUUID();await this.pool.execute('INSERT INTO clients (id,name,institution,contact,need,stage) VALUES (?,?,?,?,?,?)',[id,c.name,c.institution,c.contact,c.need,c.stage]);return {id,name:c.name,institution:c.institution,contact:c.contact,need:c.need,stage:c.stage};}
 async updateClient(id,input){const c=validateClient(input);const [result]=await this.pool.execute('UPDATE clients SET name=?,institution=?,contact=?,need=?,stage=? WHERE id=?',[c.name,c.institution,c.contact,c.need,c.stage,id]);if(!result.affectedRows){const [rows]=await this.pool.execute('SELECT id FROM clients WHERE id=?',[id]);if(!rows.length)return null;}return {id,name:c.name,institution:c.institution,contact:c.contact,need:c.need,stage:c.stage};}
 async deleteClient(id){const [result]=await this.pool.execute('DELETE FROM clients WHERE id=?',[id]);return result.affectedRows>0;}
 async listQuotes(clientId=null){
  const filter=clientId?'WHERE q.client_id=?':'';
  const [rows]=await this.pool.execute(`SELECT q.id,q.client_id AS clientId,q.snapshot,q.created_at AS createdAt,c.name AS clientName FROM quotes q LEFT JOIN clients c ON c.id=q.client_id ${filter} ORDER BY q.created_at DESC,q.id LIMIT 200`,clientId?[clientId]:[]);
  return rows.map(row=>({...row,snapshot:typeof row.snapshot==='string'?JSON.parse(row.snapshot):row.snapshot}));
 }
 async updateQuoteStatus(id,status){
  const [result]=await this.pool.execute("UPDATE quotes SET snapshot=JSON_SET(snapshot,'$.status',?) WHERE id=?",[status,id]);
  return result.affectedRows>0;
 }
 async approveQuote(id){
  const [rows]=await this.pool.execute(`SELECT q.client_id AS clientId,c.contact,
   a.password_hash IS NOT NULL AS active
   FROM quotes q LEFT JOIN clients c ON c.id=q.client_id
   LEFT JOIN client_accounts a ON a.client_id=c.id WHERE q.id=?`,[id]);
  if(!rows.length)return null;
  const [result]=await this.pool.execute(`UPDATE quotes SET snapshot=JSON_SET(snapshot,'$.status','Aprovado')
   WHERE id=? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(snapshot,'$.status')),'')<>'Aprovado'`,[id]);
  return {...rows[0],changed:result.affectedRows===1};
 }
 async clientContact(clientId){
  const [rows]=await this.pool.execute('SELECT contact FROM clients WHERE id=?',[clientId]);
  return rows[0]?.contact;
 }
 async requestQuote(client,snapshot){
  const connection=await this.pool.getConnection();
  const clientId=randomUUID(),quoteId=randomUUID();
  try{
   await connection.beginTransaction();
   await connection.execute('INSERT INTO clients (id,name,institution,contact,need,stage) VALUES (?,?,?,?,?,?)',[clientId,client.name,client.institution,client.contact,client.need,client.stage]);
   await connection.execute('INSERT INTO quotes (id,client_id,snapshot) VALUES (?,?,?)',[quoteId,clientId,JSON.stringify(snapshot)]);
   await connection.commit();
  }catch(error){await connection.rollback();throw error;}
  finally{connection.release();}
 }
 async listAccounts(){
  const [rows]=await this.pool.execute('SELECT client_id AS clientId,email,webcam_enabled AS webcamEnabled,password_hash IS NOT NULL AS active,invite_expires AS expires FROM client_accounts');
  return rows;
 }
 async inviteClient(clientId,email,hash,expires){
  try{
   const [result]=await this.pool.execute('UPDATE client_accounts SET email=?,invite_hash=?,invite_expires=? WHERE client_id=? AND password_hash IS NULL',[email,hash,expires,clientId]);
   if(result.affectedRows)return true;
   await this.pool.execute('INSERT INTO client_accounts (client_id,email,invite_hash,invite_expires) VALUES (?,?,?,?)',[clientId,email,hash,expires]);
   return true;
  }catch(error){if(['ER_DUP_ENTRY','ER_NO_REFERENCED_ROW_2'].includes(error.code))return false;throw error;}
 }
 async activateClient(inviteHash,passwordHash,now){
  const [result]=await this.pool.execute('UPDATE client_accounts SET password_hash=?,invite_hash=NULL,invite_expires=NULL WHERE invite_hash=? AND invite_expires>? AND password_hash IS NULL',[passwordHash,inviteHash,now]);
  return result.affectedRows===1;
 }
 async findAccount(email){
  const [rows]=await this.pool.execute('SELECT client_id AS clientId,password_hash AS passwordHash FROM client_accounts WHERE email=? AND password_hash IS NOT NULL',[email]);
  return rows[0];
 }
 async clientProfile(clientId){
  const [rows]=await this.pool.execute('SELECT c.name,c.institution,a.email,a.webcam_enabled AS webcamEnabled FROM client_accounts a JOIN clients c ON c.id=a.client_id WHERE a.client_id=? AND a.password_hash IS NOT NULL',[clientId]);
  return rows[0];
 }
 async setWebcam(clientId,enabled){
  const [result]=await this.pool.execute('UPDATE client_accounts SET webcam_enabled=? WHERE client_id=?',[enabled,clientId]);
  return result.affectedRows>0;
 }
 async createQuote(input){const snapshot=calculateQuote(input),id=randomUUID(),clientId=input.clientId||null;if(clientId){const [clients]=await this.pool.execute('SELECT id FROM clients WHERE id=?',[clientId]);if(!clients.length)throw new Error('Cliente não encontrado.');}await this.pool.execute('INSERT INTO quotes (id,client_id,snapshot) VALUES (?,?,?)',[id,clientId,JSON.stringify(snapshot)]);return {id,clientId,snapshot};}
 async deleteQuote(id){const [result]=await this.pool.execute('DELETE FROM quotes WHERE id=?',[id]);return result.affectedRows>0;}
 async close(){await this.pool.end();}
}
