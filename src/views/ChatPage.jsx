import React from 'react';
import './ChatPage.css';

const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// Helper function to convert markdown links to clickable links
function renderTextWithLinks(text) {
    if (!text) return text;
    
    // Convert markdown links [text](url) to HTML links
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const parts = [];
    let lastIndex = 0;
    let match;
    
    while ((match = linkRegex.exec(text)) !== null) {
        // Add text before the link
        if (match.index > lastIndex) {
            parts.push(text.substring(lastIndex, match.index));
        }
        // Add the link
        parts.push(
            <a key={match.index} href={match[2]} target="_blank" rel="noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }}>
                {match[1]}
            </a>
        );
        lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
        parts.push(text.substring(lastIndex));
    }
    
    return parts.length > 0 ? parts : text;
}

// Helper functions untuk localStorage (per-user namespace)
const getStoredConversationsByKey = (key) => {
    const storageKey = key || 'chatbot_conversations_anon';
    try {
        const stored = localStorage.getItem(storageKey);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
};

const saveConversationsByKey = (key, conversations) => {
    const storageKey = key || 'chatbot_conversations_anon';
    try {
        localStorage.setItem(storageKey, JSON.stringify(conversations));
    } catch (err) {
        console.error('Failed to save conversations:', err);
    }
};

export default function ChatPage({ user, onLogout }) {
const storageKey = React.useMemo(() => `chatbot_conversations_${user?.id_user ?? 'anon'}`, [user?.id_user]);
const [search, setSearch] = React.useState('');
const [conversations, setConversations] = React.useState(() => {
    const stored = getStoredConversationsByKey(storageKey);
    // Jika belum ada conversation, buat default
    if (Object.keys(stored).length === 0) {
        const defaultId = `chat-${Date.now()}`;
        const defaultConv = {
            id: defaultId,
            title: 'New Chat',
            messages: [],
            createdAt: Date.now()
        };
        const newConvs = { [defaultId]: defaultConv };
        saveConversationsByKey(storageKey, newConvs);
        return newConvs;
    }
    return stored;
});
const [currentChatId, setCurrentChatId] = React.useState(() => {
    const stored = getStoredConversationsByKey(storageKey);
    const ids = Object.keys(stored);
    return ids.length > 0 ? ids[ids.length - 1] : null;
});
// Reload conversations if user changes (different storageKey)
React.useEffect(() => {
    const stored = getStoredConversationsByKey(storageKey);
    if (Object.keys(stored).length === 0) {
        const defaultId = `chat-${Date.now()}`;
        const defaultConv = { id: defaultId, title: 'New Chat', messages: [], createdAt: Date.now() };
        const newConvs = { [defaultId]: defaultConv };
        setConversations(newConvs);
        setCurrentChatId(defaultId);
        saveConversationsByKey(storageKey, newConvs);
    } else {
        setConversations(stored);
        const ids = Object.keys(stored);
        setCurrentChatId(ids.length > 0 ? ids[ids.length - 1] : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [storageKey]);
const [input, setInput] = React.useState('');
const [showMenu, setShowMenu] = React.useState(false);
const [loading, setLoading] = React.useState(false);
const [hasPendingContinuation, setHasPendingContinuation] = React.useState(false);

// Get current messages
const messages = currentChatId && conversations[currentChatId] 
    ? conversations[currentChatId].messages 
    : [];

// Filter messages sesuai search
const filteredMessages = messages.filter(msg =>
    msg.text.toLowerCase().includes(search.toLowerCase())
);

// Create new chat
const handleNewChat = () => {
    const newId = `chat-${Date.now()}`;
    const newConv = {
        id: newId,
        title: 'New Chat',
        messages: [],
        createdAt: Date.now()
    };
    const updated = { ...conversations, [newId]: newConv };
    setConversations(updated);
    setCurrentChatId(newId);
    saveConversationsByKey(storageKey, updated);
};

// Switch to a different chat
const handleSelectChat = (chatId) => {
    setCurrentChatId(chatId);
    setSearch(''); // Reset search when switching
};

// Delete a chat
const handleDeleteChat = (e, chatId) => {
    e.stopPropagation();
    const updated = { ...conversations };
    delete updated[chatId];
    setConversations(updated);
    saveConversationsByKey(storageKey, updated);
    
    // If deleted chat was current, switch to another or create new
    if (chatId === currentChatId) {
        const remainingIds = Object.keys(updated);
        if (remainingIds.length > 0) {
            setCurrentChatId(remainingIds[remainingIds.length - 1]);
        } else {
            handleNewChat();
        }
    }
};


const handleSend = (e, overrideText = null) => {
    e.preventDefault();
    const textToSend = overrideText || input.trim();
    if (textToSend && currentChatId) {
        const userInput = textToSend;
        const userMsg = { id: Date.now(), sender: 'user', text: userInput };
        
        // Update messages with fresh state
        setConversations(prev => {
            const updated = { ...prev };
            if (!updated[currentChatId]) return prev;
            
            if (!updated[currentChatId].messages || updated[currentChatId].messages.length === 0) {
                // First message in this chat - update title
                if (userInput.length <= 50) {
                    updated[currentChatId].title = userInput;
                }
            }
            updated[currentChatId].messages = [...(updated[currentChatId].messages || []), userMsg];
            updated[currentChatId].updatedAt = Date.now();
            saveConversationsByKey(storageKey, updated);
            return updated;
        });
        
        if (!overrideText) {
            setInput('');
        }
        
        // Send to RAG endpoint
        (async () => {
            try {
                setLoading(true);
                // add a temporary loading bot message
                const loadingId = `loading-${Date.now()}`;
                const loadingMsg = { id: loadingId, sender: 'bot', text: 'Thinking...' };
                
                setConversations(prev => {
                    const updated = { ...prev };
                    if (!updated[currentChatId]) return prev;
                    updated[currentChatId].messages = [...updated[currentChatId].messages, loadingMsg];
                    saveConversationsByKey(storageKey, updated);
                    return updated;
                });

                const resp = await fetch(`${apiBase}/api/rag`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: userInput, top_k: 3, id_user: user?.id_user }),
                });
                const text = await resp.text();
                let body = null;
                try { body = text ? JSON.parse(text) : null; } catch (e) { console.error('Invalid JSON from /api/rag:', text); }
                
                // remove loading message and add response
                setConversations(prev => {
                    const updated = { ...prev };
                    if (!updated[currentChatId]) return prev;
                    
                    updated[currentChatId].messages = updated[currentChatId].messages.filter(m => m.id !== loadingId);

                    if (!resp.ok) {
                        const err = body && body.error ? body.error : `RAG request failed (status ${resp.status})`;
                        const errorMsg = { id: Date.now()+1, sender: 'bot', text: `Error: ${err}` };
                        updated[currentChatId].messages = [...updated[currentChatId].messages, errorMsg];
                    } else {
                        // Add answer message (include optional metadata from server)
                        const answerText = body.answer || (body?.answer?.toString && body.answer.toString()) || JSON.stringify(body);
                        const botMsg = { id: Date.now()+2, sender: 'bot', text: answerText, metadata: body.metadata || null };
                        updated[currentChatId].messages = [...updated[currentChatId].messages, botMsg];

                        // Check if answer contains continuation prompt
                        const hasContinuation = answerText.includes('lanjutkan') || answerText.includes('lanjut') || (answerText.includes('stop') && !answerText.includes('berhenti'));
                        setHasPendingContinuation(hasContinuation);
                        
                        // If user sent stop, clear continuation
                        if (userInput.toLowerCase() === 'stop') {
                            setHasPendingContinuation(false);
                        }

                        // Add sources as one combined message
                        if (Array.isArray(body.sources) && body.sources.length > 0) {
                            // Remove duplicates based on filename and page
                            const uniqueSources = [];
                            const seen = new Set();
                            for (const s of body.sources) {
                                const key = `${s.filename || ''}_${s.page || ''}`;
                                if (!seen.has(key)) {
                                    seen.add(key);
                                    uniqueSources.push(s);
                                }
                            }
                            
                            const sourcesText = uniqueSources.map(s => {
                                const pageText = s.page ? ` (page ${s.page})` : '';
                                const url = s.url || `/files/${s.filename}`;
                                return `${s.filename || ''}${pageText} — ${url}`;
                            }).join('\n');
                            
                            updated[currentChatId].messages = [...updated[currentChatId].messages, { 
                                id: Date.now() + Math.random(), 
                                sender: 'bot', 
                                text: sourcesText,
                                sources: uniqueSources.map(s => ({
                                    filename: s.filename,
                                    page: s.page,
                                    url: s.url || `/files/${s.filename}`
                                }))
                            }];
                        }
                    }
                    
                    updated[currentChatId].updatedAt = Date.now();
                    saveConversationsByKey(storageKey, updated);
                    return updated;
                });
            } catch (err) {
                setConversations(prev => {
                    const updated = { ...prev };
                    if (!updated[currentChatId]) return prev;
                    updated[currentChatId].messages = [...updated[currentChatId].messages, { 
                        id: Date.now()+3, 
                        sender: 'bot', 
                        text: 'Error: ' + String(err) 
                    }];
                    updated[currentChatId].updatedAt = Date.now();
                    saveConversations(updated);
                    return updated;
                });
            } finally {
                setLoading(false);
            }
        })();
    }
};

// Handle pause/stop button
const handlePause = () => {
    if (!currentChatId) return;
    setHasPendingContinuation(false);
    handleSend({ preventDefault: () => {} }, 'stop');
};

// Handle continue button
const handleContinue = () => {
    if (!currentChatId) return;
    handleSend({ preventDefault: () => {} }, 'lanjut');
};

// Get sorted conversations (newest first)
const sortedConversations = Object.values(conversations).sort((a, b) => 
    (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
);

return (
    <div className="chat-root">
        <aside className="chat-sidebar">
            <div className="brand">Chat</div>
            <button className="new-chat-btn" onClick={handleNewChat}>
                + New Chat
            </button>
            <div className="sidebar-search">
                <input
                    type="text"
                    placeholder="Search chat..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
            </div>
            <div className="conversations">
                {sortedConversations.map(conv => (
                    <div 
                        key={conv.id} 
                        className={`conv ${currentChatId === conv.id ? 'active' : ''}`}
                        onClick={() => handleSelectChat(conv.id)}
                        title={conv.title}
                    >
                        <span className="conv-title">{conv.title}</span>
                        <button 
                            className="delete-chat-btn"
                            onClick={(e) => handleDeleteChat(e, conv.id)}
                            title="Delete chat"
                        >
                            ×
                        </button>
                    </div>
                ))}
                {sortedConversations.length === 0 && (
                    <div className="conv-empty">No conversations yet</div>
                )}
            </div>
            <div className="user-area">
                <div
                    className="user-info"
                    role="button"
                    onClick={() => setShowMenu(!showMenu)}
                    title="Profile"
                >
                    <span className="avatar">{(user?.username || user?.email || 'U')[0].toUpperCase()}</span>
                    <span className="profile-name">{user?.username || user?.email}</span>
                    <span className="dropdown-icon">{showMenu ? "▲" : "▼"}</span>
                </div>

                {showMenu && (
                    <div className="profile-menu">
                        <button
                            className="logout-btn"
                            onClick={() => {
                                setShowMenu(false);
                                if (onLogout) onLogout();
                            }}
                        >
                            Logout
                        </button>
                    </div>
                )}
            </div>
        </aside>

        <main className="chat-main">
            <header className="chat-header">
                Welcome, {user?.username || user?.email}
            </header>
            {/* search moved to the sidebar */}
            <div className="messages">
                {filteredMessages.map(msg => (
                    <div key={msg.id} className={`msg ${msg.sender}`}>
                        <div>
                            {msg.url ? (
                                <a href={msg.url} target="_blank" rel="noreferrer">{msg.text}</a>
                            ) : msg.sources ? (
                                <div>
                                    {msg.sources.map((source, idx) => (
                                        <div key={idx} style={{ marginBottom: '4px' }}>
                                            {source.filename}{source.page ? ` (page ${source.page})` : ''} — 
                                            <a href={source.url} target="_blank" rel="noreferrer" style={{ marginLeft: '4px', color: '#2563eb', textDecoration: 'underline' }}>
                                                Link
                                            </a>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                renderTextWithLinks(msg.text)
                            )}
                        </div>
                        {msg.metadata && (
                            <div className="msg-meta" style={{ fontSize: '0.8em', color: '#666', marginTop: '6px' }}>
                                Intent: <strong>{msg.metadata.intent}</strong>
                                {' · '}
                                Sentiment: <strong>{msg.metadata.sentiment.label}</strong> ({Number(msg.metadata.sentiment.score).toFixed(2)})
                            </div>
                        )}
                    </div>
                ))}
            </div>

            <form className="chat-input" onSubmit={handleSend}>
                {hasPendingContinuation && (
                    <div className="control-buttons">
                        <button 
                            type="button" 
                            className="pause-btn" 
                            onClick={handlePause}
                            title="Pause/Stop"
                        >
                            ⏸
                        </button>
                        <button 
                            type="button" 
                            className="continue-btn" 
                            onClick={handleContinue}
                            title="Lanjutkan"
                        >
                            ▶
                        </button>
                    </div>
                )}
                <input
                    placeholder="Ask anything..."
                    value={input}
                    onChange={e => setInput(e.target.value)}
                />
                <button type="submit">Send</button>
            </form>
        </main>
    </div>
);
}
