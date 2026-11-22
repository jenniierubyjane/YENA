import fs from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {connectWhenReady,ensureLocalMySQL,runtime} from './mysql-local.mjs';
if(fs.existsSync('.env'))process.loadEnvFile('.env');
const database=await ensureLocalMySQL();
try {
 if(process.env.MYSQL_LOCAL==='true'){
  const {password}=JSON.parse(fs.readFileSync(path.join(runtime,'mysql-admin.json'),'utf8'));
  const connection=await connectWhenReady({user:'root',password,database:process.env.MYSQL_DATABASE});
  try{
   for(const statement of fs.readFileSync('database/schema.sql','utf8').split(';').map(sql=>sql.trim()).filter(Boolean))await connection.query(statement);
  }finally{await connection.end();}
 }
}catch(error){await database.stop();throw error;}
const app=spawn(process.execPath,['server/index.mjs'],{windowsHide:true,stdio:'inherit',env:process.env});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;app.kill();await database.stop();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
app.on('error',async()=>{console.error('Não foi possível iniciar a YENA.');await stop();process.exitCode=1;});
app.on('exit',async code=>{await database.stop();process.exitCode=code||0;});
