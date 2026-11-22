import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';

const {
 MYSQL_HOST,MYSQL_PORT,MYSQL_DATABASE,MYSQL_USER,MYSQL_PASSWORD,
 MYSQL_SETUP_USER,MYSQL_SETUP_PASSWORD,YENA_ADMIN_PASSWORD
}=process.env;

if(!MYSQL_HOST||!MYSQL_PORT||!MYSQL_DATABASE||!MYSQL_SETUP_USER||!MYSQL_SETUP_PASSWORD||
   MYSQL_USER!=='yena_app'||!MYSQL_PASSWORD||!YENA_ADMIN_PASSWORD||YENA_ADMIN_PASSWORD.length<12){
 console.error('Configure as variáveis da YENA e do banco antes de publicar.');
 process.exit(1);
}

let connection;
try{
 connection=await mysql.createConnection({
  host:MYSQL_HOST,port:Number(MYSQL_PORT),database:MYSQL_DATABASE,
  user:MYSQL_SETUP_USER,password:MYSQL_SETUP_PASSWORD,connectTimeout:10000
 });
 const schema=await fs.readFile(new URL('../database/schema.sql',import.meta.url),'utf8');
 for(const statement of schema.split(';').map(sql=>sql.trim()).filter(Boolean))await connection.query(statement);
 await connection.query("CREATE USER IF NOT EXISTS 'yena_app'@'%' IDENTIFIED BY ?",[MYSQL_PASSWORD]);
 await connection.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ??.* TO 'yena_app'@'%'",[MYSQL_DATABASE]);
 const app=await mysql.createConnection({
  host:MYSQL_HOST,port:Number(MYSQL_PORT),database:MYSQL_DATABASE,
  user:MYSQL_USER,password:MYSQL_PASSWORD,connectTimeout:10000
 });
 await app.end();
 console.log('Banco da apresentação preparado.');
}catch(error){
 console.error('Falha ao preparar o banco da apresentação:',error.code||error.name);
 process.exitCode=1;
}finally{
 await connection?.end();
}
