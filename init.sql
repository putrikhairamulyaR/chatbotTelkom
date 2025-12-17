USE ai_chatbot;

CREATE TABLE IF NOT EXISTS `user` (
  id_user INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) UNIQUE,
  email VARCHAR(255) UNIQUE,
  password VARCHAR(255),
  prodi VARCHAR(100),
  role ENUM('user', 'admin') DEFAULT 'user',
  answer_preference ENUM('long', 'short', 'auto') DEFAULT 'auto',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- user test (password plain '123' untuk sementara)
INSERT INTO `user` (username,email,password,prodi,role)
VALUES ('p','putri@example.com','123','Informatika','user')
ON DUPLICATE KEY UPDATE username = username;

-- Admin user (NIP 199, password 123)
INSERT INTO `user` (username,email,password,prodi,role)
VALUES ('199','admin@telkom.ac.id','123','Admin','admin')
ON DUPLICATE KEY UPDATE username = username;

-- Conversation memory table to store compact per-user messages and analysis
CREATE TABLE IF NOT EXISTS `conversation_memory` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_user INT NULL,
  sender ENUM('user','bot') NOT NULL,
  message TEXT,
  intent VARCHAR(80),
  sentiment_score FLOAT,
  sentiment_label VARCHAR(32),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (id_user),
  FULLTEXT KEY msg_ft (message)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audit log table untuk tracking aktivitas admin
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

-- User log table untuk tracking aktivitas semua user
CREATE TABLE IF NOT EXISTS `user_log` (
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
  FOREIGN KEY (id_user) REFERENCES `user`(id_user) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;