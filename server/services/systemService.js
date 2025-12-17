// server/services/systemService.js
import { pool } from '../db.js';

export async function ensureAdminUser() {
  try {
    try {
      const [columns] = await pool.query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'role'"
      );
      if (columns.length === 0) {
        await pool.query("ALTER TABLE `user` ADD COLUMN role ENUM('user', 'admin') DEFAULT 'user' AFTER prodi");
        console.log('[init] Added role column to user table');
      }
    } catch (alterErr) {
      console.warn('[init] Could not check/add role column:', alterErr?.message);
    }

    const [rows] = await pool.query('SELECT id_user, password, role FROM `user` WHERE username = ?', ['199']);
    if (rows.length === 0) {
      try {
        await pool.query(
          'INSERT INTO `user` (username, email, password, prodi, role) VALUES (?, ?, ?, ?, ?)',
          ['199', 'admin@telkom.ac.id', '123', 'Admin', 'admin']
        );
        console.log('[init] ✓ Admin user created: username=199, password=123');
      } catch (insertErr) {
        if (insertErr.message && insertErr.message.includes('role')) {
          await pool.query(
            'INSERT INTO `user` (username, email, password, prodi) VALUES (?, ?, ?, ?)',
            ['199', 'admin@telkom.ac.id', '123', 'Admin']
          );
          console.log('[init] ✓ Admin user created (without role): username=199, password=123');
        } else {
          throw insertErr;
        }
      }
    } else {
      try {
        const [roleCheck] = await pool.query(
          "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'role'"
        );
        if (roleCheck.length > 0) {
          await pool.query(
            'UPDATE `user` SET password = ?, role = ?, email = ?, prodi = ? WHERE username = ?',
            ['123', 'admin', 'admin@telkom.ac.id', 'Admin', '199']
          );
        } else {
          await pool.query(
            'UPDATE `user` SET password = ?, email = ?, prodi = ? WHERE username = ?',
            ['123', 'admin@telkom.ac.id', 'Admin', '199']
          );
        }
      } catch (updateErr) {
        await pool.query(
          'UPDATE `user` SET password = ?, email = ?, prodi = ? WHERE username = ?',
          ['123', 'admin@telkom.ac.id', 'Admin', '199']
        );
      }
      console.log('[init] ✓ Admin user verified/updated: username=199, password=123');
    }
  } catch (err) {
    console.error('[init] ✗ Failed to ensure admin user:', err?.message);
    console.error('[init] Error details:', err);
  }
}

export async function ensureUserLogTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`user_log\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_user INT NULL,
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(50),
        resource_id VARCHAR(255),
        details TEXT,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (id_user),
        INDEX (action),
        INDEX (created_at),
        FOREIGN KEY (id_user) REFERENCES \`user\`(id_user) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[init] ✓ user_log table verified');
  } catch (err) {
    console.warn('[init] Could not ensure user_log table:', err?.message);
  }
}

export async function ensureUserNimColumn() {
  try {
    const [columns] = await pool.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'nim'"
    );
    if (columns.length === 0) {
      await pool.query("ALTER TABLE `user` ADD COLUMN nim VARCHAR(100) NULL AFTER username");
      console.log('[init] ✓ Added nim column to user table');
    }
  } catch (err) {
    console.warn('[init] Could not ensure nim column:', err?.message);
  }
}
