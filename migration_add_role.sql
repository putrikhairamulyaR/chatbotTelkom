-- Migration script untuk menambahkan role field dan admin user
-- Jalankan script ini jika database sudah ada dan perlu update schema

USE ai_chatbot;

-- Tambahkan kolom role jika belum ada
ALTER TABLE `user` 
ADD COLUMN IF NOT EXISTS role ENUM('user', 'admin') DEFAULT 'user' AFTER prodi;

-- Update existing users to have 'user' role (jika null)
UPDATE `user` SET role = 'user' WHERE role IS NULL;

-- Tambahkan admin user (NIP 199, password 123)
INSERT INTO `user` (username, email, password, prodi, role)
VALUES ('199', 'admin@telkom.ac.id', '123', 'Admin', 'admin')
ON DUPLICATE KEY UPDATE role = 'admin';

-- Buat tabel audit_log jika belum ada
CREATE TABLE IF NOT EXISTS `audit_log` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_user INT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id VARCHAR(255),
  details TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (id_user),
  INDEX (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

