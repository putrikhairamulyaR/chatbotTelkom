USE ai_chatbot;

CREATE TABLE IF NOT EXISTS `user` (
  id_user INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) UNIQUE,
  email VARCHAR(255) UNIQUE,
  password VARCHAR(255),
  prodi VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- user test (password plain '123' untuk sementara)
INSERT INTO `user` (username,email,password,prodi)
VALUES ('p','putri@example.com','123','Informatika')
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