import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// Centralized DB pool so routes and utils can reuse it
export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ai_chatbot',
  connectionLimit: 10,
});

export default pool;
