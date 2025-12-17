-- Script untuk menambahkan/update user admin
-- Jalankan script ini di MySQL untuk memastikan user admin ada

USE ai_chatbot;

-- Pastikan kolom role ada
ALTER TABLE `user` 
ADD COLUMN IF NOT EXISTS role ENUM('user', 'admin') DEFAULT 'user' AFTER prodi;

-- Insert atau update admin user (NIP 199, password 123)
-- Menggunakan INSERT ... ON DUPLICATE KEY UPDATE untuk memastikan user ada
INSERT INTO `user` (username, email, password, prodi, role)
VALUES ('199', 'admin@telkom.ac.id', '123', 'Admin', 'admin')
ON DUPLICATE KEY UPDATE 
  email = 'admin@telkom.ac.id',
  password = '123',
  prodi = 'Admin',
  role = 'admin';

-- Verifikasi user admin sudah ada
SELECT id_user, username, email, role FROM `user` WHERE username = '199';

