import React from 'react';
import './ChatPage.css';

const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function ChatPage({ user, onLogout }) {
const [search, setSearch] = React.useState('');
const [messages, setMessages] = React.useState([
    { id: 1, sender: 'bot', text: 'Hello — this is a demo chat page.' },
    { id: 2, sender: 'user', text: 'Hi bot!' },
    { id: 3, sender: 'bot', text: 'How can I help you?' },
    // Tambahkan history chat lain di sini
]);
const [input, setInput] = React.useState('');
const [showMenu, setShowMenu] = React.useState(false);
const [loading, setLoading] = React.useState(false);

// Filter messages sesuai search
const filteredMessages = messages.filter(msg =>
    msg.text.toLowerCase().includes(search.toLowerCase())
);

const handleSend = (e) => {
    e.preventDefault();
    if (input.trim()) {
        const userMsg = { id: Date.now(), sender: 'user', text: input };
        setMessages(prev => [...prev, userMsg]);
        setInput('');
        // Send to RAG endpoint
        (async () => {
            try {
                setLoading(true);
                // add a temporary loading bot message
                const loadingId = `loading-${Date.now()}`;
                setMessages(prev => [...prev, { id: loadingId, sender: 'bot', text: 'Thinking...' }]);

                const resp = await fetch(`${apiBase}/api/rag`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: input, top_k: 3 }),
                });
                const text = await resp.text();
                let body = null;
                try { body = text ? JSON.parse(text) : null; } catch (e) { console.error('Invalid JSON from /api/rag:', text); }
                // remove loading message
                setMessages(prev => prev.filter(m => m.id !== loadingId));

                if (!resp.ok) {
                    const err = body && body.error ? body.error : `RAG request failed (status ${resp.status})`;
                    setMessages(prev => [...prev, { id: Date.now()+1, sender: 'bot', text: `Error: ${err}` }]);
                    return;
                }

                // Add answer message (include optional metadata from server)
                const answerText = body.answer || (body?.answer?.toString && body.answer.toString()) || JSON.stringify(body);
                const botMsg = { id: Date.now()+2, sender: 'bot', text: answerText, metadata: body.metadata || null };
                setMessages(prev => [...prev, botMsg]);

                // Add sources as separate messages (small)
                if (Array.isArray(body.sources)) {
                    for (const s of body.sources) {
                        const srcText = `${s.filename || ''}${s.page ? ' (page ' + s.page + ')' : ''} — ${s.snippet ? s.snippet.slice(0,200) : ''}`;
                        setMessages(prev => [...prev, { id: Date.now() + Math.random(), sender: 'bot', text: srcText, url: (s.url || `/files/${s.filename}`) }]);
                    }
                }
            } catch (err) {
                setMessages(prev => [...prev, { id: Date.now()+3, sender: 'bot', text: 'Error: ' + String(err) }]);
            } finally {
                setLoading(false);
            }
        })();
    }
};

return (
    <div className="chat-root">
        <aside className="chat-sidebar">
            <div className="brand">Chat</div>
            <div className="sidebar-search">
                <input
                    type="text"
                    placeholder="Search chat..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
            </div>
            <div className="conversations">
                <div className="conv active">General</div>
                <div className="conv">Project A</div>
                <div className="conv">Random</div>
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
                            {msg.url ? <a href={msg.url} target="_blank" rel="noreferrer">{msg.text}</a> : msg.text}
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
