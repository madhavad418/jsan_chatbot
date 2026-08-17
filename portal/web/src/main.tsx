import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp, Check, ChevronDown, Code2, Copy, Gauge, KeyRound, LogOut,
  Menu, MessageSquarePlus, Moon, Paperclip, RotateCcw, Search, Sparkles,
  Sun, Terminal, Trash2, Wrench, X, Zap, BrainCircuit, Bug, GitPullRequest,
  Blocks, BookOpenText, ShieldCheck, ExternalLink, CheckCircle2
} from 'lucide-react';
import './styles.css';

type User = { id:string; name:string; email:string };
type Conv = { id:string; title:string; mode:string; updated_at:string };
type Msg = { role:'user'|'assistant'; content:string };
type Mode = 'auto'|'code'|'think'|'fast';
type Usage = { spend:number; maxBudget:number|null; budgetDuration:string|null; models:string[]; rpmLimit:number|null; tpmLimit:number|null };

type Attachment = { name:string; size:number; content:string };

const MODES:{id:Mode; label:string; hint:string; icon:any}[] = [
  {id:'auto', label:'Auto', hint:'Best fit for the task', icon:Sparkles},
  {id:'code', label:'Code', hint:'Build, debug and review', icon:Code2},
  {id:'think', label:'Think', hint:'Architecture and deeper reasoning', icon:BrainCircuit},
  {id:'fast', label:'Fast', hint:'Quick answers and small tasks', icon:Zap}
];

/** The shortcut is Ctrl on Windows/Linux — showing ⌘ there is just wrong. */
const SHORTCUT_LABEL = /Mac|iPhone|iPad/.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
) ? '⌘K' : 'Ctrl K';

const QUICK = [
  {icon:Bug,title:'Fix a bug',desc:'Find the cause and verify the fix',text:'Help me debug this issue. Identify the likely root cause, propose the safest fix, and include concrete verification steps.'},
  {icon:GitPullRequest,title:'Review code',desc:'Check correctness, security and quality',text:'Review this code for correctness, security, performance and maintainability. Prioritize material issues and suggest focused improvements.'},
  {icon:Blocks,title:'Build a feature',desc:'Design it and implement it cleanly',text:'Help me design and implement this feature with production-ready code, clear assumptions, edge cases and verification steps.'},
  {icon:BookOpenText,title:'Explain code',desc:'Understand unfamiliar code quickly',text:'Explain what this code does in simple terms, then call out important dependencies, risks and opportunities to improve it.'}
];

async function api(path:string, options:RequestInit = {}) {
  const res = await fetch(path, {
    credentials:'include',
    ...options,
    headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function CopyButton({value,small=false}:{value:string;small?:boolean}) {
  const [done,setDone] = useState(false);
  return <button className={`icon-button ${small?'small':''}`} title="Copy" onClick={async()=>{
    await navigator.clipboard.writeText(value); setDone(true); setTimeout(()=>setDone(false),1200);
  }}>{done ? <Check size={14}/> : <Copy size={14}/>}</button>;
}

/** JSAN wordmark + product lockup. `invert` renders it white for blue panels. */
function Brand({compact=false, invert=false, size='md'}:{compact?:boolean; invert?:boolean; size?:'md'|'lg'}) {
  return <div className={`brand${compact?' compact':''}${invert?' brand-invert':''}${size==='lg'?' brand-lg':''}`}>
    <img className="brand-logo" src="/jsan-logo.png" alt="JSAN" />
    {!compact && <>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-product">Dev AI</span>
    </>}
  </div>;
}

function ThemeButton(){
  const [dark,setDark]=useState(()=>localStorage.getItem('jsan-theme')==='dark');
  useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';localStorage.setItem('jsan-theme',dark?'dark':'light')},[dark]);
  return <button className="icon-button" title={dark?'Use light theme':'Use dark theme'} onClick={()=>setDark(v=>!v)}>{dark?<Sun size={15}/>:<Moon size={15}/>}</button>
}

function Auth({onReady}:{onReady:(u:User)=>void}) {
  const [tab,setTab] = useState<'login'|'register'>('login');
  const [form,setForm] = useState({name:'',email:'',password:'',accessCode:''});
  const [status,setStatus] = useState<any>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  useEffect(()=>{ api('/api/auth/registration-status').then(setStatus).catch(()=>{}); },[]);
  const submit = async(e:React.FormEvent)=>{
    e.preventDefault(); setBusy(true); setError('');
    try { const data = await api(`/api/auth/${tab}`,{method:'POST',body:JSON.stringify(form)}); onReady(data.user); }
    catch(e:any){ setError(e.message); } finally { setBusy(false); }
  };
  const canRegister = status?.registrationOpen !== false;
  return <div className="auth-screen">
    <div className="auth-glow glow-a"/><div className="auth-glow glow-b"/>
    <header className="auth-top"><Brand/><ThemeButton/></header>
    <main className="auth-main">
      <section className="auth-intro">
        <div className="auth-intro-brand"><Brand invert size="lg"/></div>
        <div className="auth-intro-body">
          <div className="product-chip"><Sparkles size={13}/> Built for engineering work</div>
          <h1>Move from question<br/>to working code faster.</h1>
          <p>A focused AI workspace for debugging, implementation, code review and architecture—available in the browser and your coding tools.</p>
          <div className="auth-proof">
            <div><CheckCircle2 size={16}/><span>One workspace</span></div>
            <div><CheckCircle2 size={16}/><span>One developer key</span></div>
            <div><CheckCircle2 size={16}/><span>Multiple AI providers</span></div>
          </div>
        </div>
        <p className="auth-intro-foot">JSAN Consulting — Global IT Partner</p>
      </section>
      <section className="auth-card">
        <div className="auth-card-head">
          <div><span className="eyebrow">JSAN Engineering</span><h2>{tab==='login' ? 'Welcome back' : 'Create your account'}</h2></div>
          {tab==='register'&&status&&<span className="seat-pill">{status.remaining} seats left</span>}
        </div>
        <p>{tab==='login' ? 'Continue where you left off.' : 'Use your work email and team access code.'}</p>
        <div className="auth-tabs">
          <button className={tab==='login'?'active':''} onClick={()=>{setTab('login');setError('')}}>Sign in</button>
          <button disabled={!canRegister} className={tab==='register'?'active':''} onClick={()=>{setTab('register');setError('')}}>Register</button>
        </div>
        <form onSubmit={submit}>
          {tab==='register' && <label>Full name<input autoComplete="name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Your name" required/></label>}
          <label>Work email<input autoComplete="email" type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="name@jsanconsulting.com" required/></label>
          <label>Password<input autoComplete={tab==='login'?'current-password':'new-password'} type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} placeholder="At least 10 characters" required/></label>
          {tab==='register' && <label>Team access code<input value={form.accessCode} onChange={e=>setForm({...form,accessCode:e.target.value})} placeholder="Code shared by your team" required/></label>}
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button full" disabled={busy}>{busy?'Please wait…':tab==='login'?'Sign in':'Create account'}</button>
        </form>
        <div className="auth-security"><ShieldCheck size={14}/><span>Provider credentials are never exposed to developer devices.</span></div>
      </section>
    </main>
  </div>;
}

function App() {
  const [user,setUser] = useState<User|null>(null);
  const [loading,setLoading] = useState(true);
  const [page,setPage] = useState<'chat'|'tools'|'usage'>('chat');
  const [mobileNav,setMobileNav] = useState(false);
  // Bumping this tells an already-mounted Chat to clear itself. It lives here
  // rather than in Chat because the shortcut and the button must work from
  // Tools and Usage too, where Chat is not mounted to hear a window event.
  const [newChatToken,setNewChatToken] = useState(0);
  useEffect(()=>{ api('/api/me').then(setUser).catch(()=>{}).finally(()=>setLoading(false)); },[]);

  const startNewChat = useCallback(()=>{
    setPage('chat');
    setMobileNav(false);
    setNewChatToken(t=>t+1);
  },[]);

  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); startNewChat(); }
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[startNewChat]);
  if(loading) return <div className="boot"><Brand/></div>;
  if(!user) return <Auth onReady={setUser}/>;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav?'show':''}`}>
      <div className="sidebar-top"><Brand/><button className="mobile-close icon-button" onClick={()=>setMobileNav(false)}><X size={17}/></button></div>
      <button className="new-chat" onClick={startNewChat}><MessageSquarePlus size={16}/><span>New chat</span><kbd>{SHORTCUT_LABEL}</kbd></button>
      <nav>
        <button className={page==='chat'?'active':''} onClick={()=>{setPage('chat');setMobileNav(false)}}><Sparkles size={16}/><span>Chat</span></button>
        <button className={page==='tools'?'active':''} onClick={()=>{setPage('tools');setMobileNav(false)}}><Terminal size={16}/><span>Tools</span></button>
        <button className={page==='usage'?'active':''} onClick={()=>{setPage('usage');setMobileNav(false)}}><Gauge size={16}/><span>Usage</span></button>
      </nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-foot">
        <div className="avatar">{user.name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase()}</div>
        <div className="who"><strong>{user.name}</strong><span>{user.email}</span></div>
        <ThemeButton/>
        <button className="icon-button" title="Sign out" onClick={async()=>{await api('/api/auth/logout',{method:'POST'});setUser(null)}}><LogOut size={15}/></button>
      </div>
    </aside>
    <main className="main-area">
      <button className="mobile-menu icon-button" onClick={()=>setMobileNav(true)}><Menu size={18}/></button>
      {/* Chat stays mounted so switching to Tools/Usage and back keeps the
          open conversation, the draft and the scroll position. */}
      <Chat newChatToken={newChatToken} hidden={page!=='chat'}/>
      {page==='tools' && <Tools/>}
      {page==='usage' && <UsagePage/>}
    </main>
  </div>;
}

function Chat({newChatToken=0, hidden=false}:{newChatToken?:number; hidden?:boolean}) {
  const [convs,setConvs] = useState<Conv[]>([]);
  const [active,setActive] = useState<string|null>(null);
  const [messages,setMessages] = useState<Msg[]>([]);
  const [mode,setMode] = useState<Mode>('auto');
  const [modeOpen,setModeOpen] = useState(false);
  const [input,setInput] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [historyOpen,setHistoryOpen] = useState(false);
  const [search,setSearch] = useState('');
  const [attachments,setAttachments]=useState<Attachment[]>([]);
  const fileRef=useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const refresh = ()=>api('/api/conversations').then(setConvs).catch(()=>{});
  // Load the list on mount and again each time the user comes back to Chat,
  // so anything started in another tab or on another machine shows up.
  useEffect(()=>{
    if(!hidden) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[hidden]);
  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:'smooth'}); },[messages,busy]);
  // Clear the workspace whenever "New chat" is triggered, from any page.
  // Focusing the composer is what makes the click feel like it did something —
  // without it, pressing New chat on an already-empty chat looks like a no-op.
  // Skipped on the first run: the workspace is already empty at mount, and the
  // effect above has the list covered.
  const firstToken = useRef(true);
  useEffect(()=>{
    if(firstToken.current){ firstToken.current = false; return; }
    setActive(null); setMessages([]); setInput(''); setMode('auto'); setError(''); setAttachments([]);
    if(!hidden) composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[newChatToken]);
  const load = async(id:string)=>{ const d=await api(`/api/conversations/${id}`); setActive(id); setMessages(d.messages.map((m:any)=>({role:m.role,content:m.content}))); setMode((d.mode||'auto') as Mode); setHistoryOpen(false); };
  const pickFiles=async(files:FileList|null)=>{if(!files)return;const next:Attachment[]=[];for(const f of Array.from(files).slice(0,4)){if(f.size>750_000)continue;try{next.push({name:f.name,size:f.size,content:await f.text()})}catch{}}setAttachments(a=>[...a,...next].slice(0,4));if(fileRef.current)fileRef.current.value=''};
  const send = async(text=input)=>{
    const base=text.trim(); if((!base&&!attachments.length)||busy)return;
    const attached=attachments.map(a=>`\n\n--- Attached file: ${a.name} ---\n${a.content}\n--- End ${a.name} ---`).join('');
    const message=(base||'Please review the attached file(s).')+attached;
    const display=base+(attachments.length?`\n\n${attachments.map(a=>`📎 ${a.name}`).join('\n')}`:'');
    setInput(''); setAttachments([]); setError(''); setBusy(true); setMessages(m=>[...m,{role:'user',content:display}]);
    try{ const d=await api('/api/chat',{method:'POST',body:JSON.stringify({message,mode,conversationId:active})}); setActive(d.conversationId); setMessages(m=>[...m,{role:'assistant',content:d.answer}]); refresh(); }
    catch(e:any){setMessages(m=>m.slice(0,-1));setInput(base);setError(e.message)} finally {setBusy(false)}
  };
  const del = async(e:React.MouseEvent,id:string)=>{e.stopPropagation();await api(`/api/conversations/${id}`,{method:'DELETE'});if(active===id){setActive(null);setMessages([])}refresh()};
  const currentMode=MODES.find(m=>m.id===mode)!; const ModeIcon=currentMode.icon;
  const filtered=convs.filter(c=>c.title.toLowerCase().includes(search.toLowerCase()));
  return <div className={`chat-layout${hidden?' is-hidden':''}`}>
    <aside className={`history ${historyOpen?'show':''}`}>
      <div className="history-head"><span>Conversations</span><button className="mobile-close icon-button" onClick={()=>setHistoryOpen(false)}><X size={15}/></button></div>
      <div className="history-search"><Search size={13}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search"/></div>
      <div className="history-list">{filtered.length===0?<div className="history-empty">{convs.length?'No matches yet.':'Your recent work will appear here.'}</div>:filtered.map(c=><button key={c.id} className={`history-item ${active===c.id?'active':''}`} onClick={()=>load(c.id)}><span>{c.title}</span><Trash2 onClick={e=>del(e,c.id)} size={13}/></button>)}</div>
    </aside>
    <section className="workspace">
      <header className="workspace-header">
        <div className="workspace-left"><button className="history-toggle icon-button" onClick={()=>setHistoryOpen(true)}><Menu size={15}/></button><div className="status-dot"/><strong>{active?'Conversation':'New chat'}</strong></div>
        <div className="mode-select">
          <button onClick={()=>setModeOpen(v=>!v)}><ModeIcon size={14}/>{currentMode.label}<ChevronDown size={14}/></button>
          {modeOpen&&<div className="mode-menu">{MODES.map(m=>{const I=m.icon;return <button key={m.id} className={m.id===mode?'selected':''} onClick={()=>{setMode(m.id);setModeOpen(false)}}><I size={15}/><div><strong>{m.label}</strong><span>{m.hint}</span></div>{m.id===mode&&<Check size={14}/>}</button>})}</div>}
        </div>
      </header>
      <div className="thread">
        {messages.length===0 ? <div className="empty-state">
          <div className="hero-kicker"><span className="pulse-dot"/> Ready to work</div>
          <h1>What are you building?</h1>
          <p>Bring a bug, a feature, a codebase question or an architecture decision.</p>
          <div className="quick-grid">{QUICK.map(q=>{const I=q.icon;return <button key={q.title} onClick={()=>{setInput(q.text);setTimeout(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),0)}}><div className="quick-icon"><I size={16}/></div><div><strong>{q.title}</strong><span>{q.desc}</span></div><ArrowUp size={14}/></button>})}</div>
          <div className="starter-note"><ShieldCheck size={14}/><span>Use approved work content only. Review generated code before merging.</span></div>
        </div> : messages.map((m,i)=>m.role==='user' ? <div className="user-message" key={i}><div>{m.content}</div></div> : <div className="assistant-message" key={i}><div className="assistant-icon"><Sparkles size={14}/></div><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown><button className="copy-answer" onClick={()=>navigator.clipboard.writeText(m.content)}><Copy size={12}/>Copy response</button></div></div>)}
        {busy&&<div className="assistant-message"><div className="assistant-icon"><Sparkles size={14}/></div><div className="thinking"><span>Working</span><i/><i/><i/></div></div>}
        {error&&<div className="chat-error">{error}</div>}
        <div ref={endRef}/>
      </div>
      <footer className="composer-area">
        <div className="composer">
          {attachments.length>0&&<div className="attachments">{attachments.map((a,i)=><span key={a.name+i}><Code2 size={12}/>{a.name}<button onClick={()=>setAttachments(x=>x.filter((_,j)=>j!==i))}><X size={11}/></button></span>)}</div>}
          <textarea ref={composerRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}} placeholder="Ask about code, bugs, architecture or implementation…" rows={1}/>
          <div className="composer-foot"><div className="composer-actions"><input ref={fileRef} type="file" multiple hidden onChange={e=>pickFiles(e.target.files)}/><button className="composer-tool" title="Attach text or code files" onClick={()=>fileRef.current?.click()}><Paperclip size={14}/><span>Attach</span></button><span className="mode-label"><ModeIcon size={12}/>{currentMode.label}</span></div><div className="send-side"><span>Enter to send</span><button className="send-button" disabled={(!input.trim()&&!attachments.length)||busy} onClick={()=>send()}><ArrowUp size={16}/></button></div></div>
        </div>
      </footer>
    </section>
  </div>;
}

function Tools() {
  const [key,setKey] = useState(''); const [cfg,setCfg] = useState<any>(null); const [show,setShow] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  useEffect(()=>{Promise.all([api('/api/me/api-key'),api('/api/tools/config')]).then(([k,c])=>{setKey(k.apiKey);setCfg(c)}).catch(e=>setError(e.message))},[]);
  const rotate=async()=>{if(!confirm('Rotate your developer key? Tools using the old key will stop working.'))return;setBusy(true);setError('');try{const d=await api('/api/me/api-key/rotate',{method:'POST'});setKey(d.apiKey)}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">Developer tools</span><h1>Take the same AI into your editor.</h1><p>Use one JSAN endpoint and your personal key across supported coding tools.</p></div><div className="header-badge"><span/><strong>Gateway ready</strong></div></header>
    {error&&<div className="page-error">{error}</div>}
    <div className="content-grid">
      <section className="card span-2 key-card"><div className="card-head"><div><div className="card-icon"><KeyRound size={17}/></div><div><h2>Your developer key</h2><p>Use it in your own tools. Keep it private.</p></div></div><button className="secondary-button" onClick={rotate} disabled={busy}><RotateCcw size={14}/>{busy?'Rotating…':'Rotate key'}</button></div><div className="key-box"><code>{show?key:key?`${key.slice(0,8)}${'•'.repeat(30)}${key.slice(-5)}`:'Loading…'}</code><button className="text-button" onClick={()=>setShow(v=>!v)}>{show?'Hide':'Show'}</button><CopyButton value={key}/></div></section>
      <ToolCard icon={<Code2 size={17}/>} title="Codex CLI" text="Use Code mode through the JSAN gateway." value={cfg?.codex||''} note="Set JSAN_AI_KEY to your developer key."/>
      <ToolCard icon={<Sparkles size={17}/>} title="Claude Code" text="Route Claude Code through the same gateway." value={cfg?.claude||''} note="Use your developer key as the Anthropic auth token."/>
      <ToolCard icon={<Terminal size={17}/>} title="OpenAI-compatible tools" text="For IDEs, SDKs and local scripts." value={cfg?.env||''} note={`Base URL: ${cfg?.baseUrl||'—'}`}/>
      <ToolCard icon={<Wrench size={17}/>} title="Connection check" text="Confirm your endpoint and key in one command." value={cfg?.curl||''} note="A model list means the connection is working."/>
      <section className="card span-2 tool-help"><div><h2>Recommended setup</h2><p>Use the browser for discussion and quick reviews. Use Codex or Claude Code when you want AI working directly with a repository.</p></div><a href="https://ai.jsanconsulting.com/v1" target="_blank" rel="noreferrer">API endpoint <ExternalLink size={13}/></a></section>
    </div>
  </div>;
}

function ToolCard({icon,title,text,value,note}:{icon:any;title:string;text:string;value:string;note:string}){return <section className="card"><div className="card-head simple"><div><div className="card-icon">{icon}</div><div><h2>{title}</h2><p>{text}</p></div></div></div><Snippet value={value}/><p className="card-note">{note}</p></section>}
function Snippet({value}:{value:string}) { return <div className="snippet"><pre>{value||'Loading…'}</pre><CopyButton value={value}/></div> }

function UsagePage() {
  const [data,setData] = useState<Usage|null>(null); const [error,setError] = useState('');
  useEffect(()=>{api('/api/usage/me').then(setData).catch(e=>setError(e.message))},[]);
  const pct = useMemo(()=>data?.maxBudget ? Math.min(100,(data.spend/data.maxBudget)*100) : 0,[data]);
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">Usage</span><h1>Simple visibility, no guesswork.</h1><p>See the access attached to your developer key without worrying about provider-level details.</p></div></header>
    {error&&<div className="page-error">{error}</div>}
    {!data?<div className="skeleton"/>:<div className="content-grid">
      <section className="metric-card"><span>Current spend</span><strong>${data.spend.toFixed(2)}</strong><small>{data.budgetDuration?'Current budget period':'Tracked by the gateway'}</small></section>
      <section className="metric-card"><span>Personal budget</span><strong>{data.maxBudget==null?'Flexible':`$${data.maxBudget.toFixed(2)}`}</strong><small>{data.maxBudget==null?'No personal cap configured':`${Math.max(0,100-pct).toFixed(0)}% remaining`}</small></section>
      <section className="metric-card"><span>Work modes</span><strong>{data.models.length}</strong><small>Auto · Code · Think · Fast</small></section>
      <section className="metric-card"><span>Access</span><strong>{data.rpmLimit||'Managed'}</strong><small>{data.rpmLimit?'Requests per minute':'Handled centrally'}</small></section>
      {data.maxBudget!=null&&<section className="card span-2"><div className="budget-line"><div><h2>Budget use</h2><p>${data.spend.toFixed(2)} of ${data.maxBudget.toFixed(2)}</p></div><strong>{pct.toFixed(0)}%</strong></div><div className="progress"><span style={{width:`${pct}%`}}/></div></section>}
      <section className="card span-2 mode-guide"><div><span className="mode-symbol auto"><Sparkles size={16}/></span><strong>Auto</strong><p>Default for everyday work.</p></div><div><span className="mode-symbol code"><Code2 size={16}/></span><strong>Code</strong><p>Implementation and debugging.</p></div><div><span className="mode-symbol think"><BrainCircuit size={16}/></span><strong>Think</strong><p>Architecture and complex reasoning.</p></div><div><span className="mode-symbol fast"><Zap size={16}/></span><strong>Fast</strong><p>Quick questions and small tasks.</p></div></section>
    </div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
