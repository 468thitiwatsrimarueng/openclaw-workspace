import React, { useState, useRef, useEffect } from 'react';
import { Send, Menu, X, Settings2, User, Bot, Loader2, MessageSquare } from 'lucide-react';
import * as ed from '@noble/ed25519';
import ReactMarkdown from 'react-markdown';

// noble/ed25519 v2 requires sha512 — provide it via Web Crypto API
ed.etc.sha512Async = async (...msgs) => {
  const combined = new Uint8Array(msgs.reduce((acc, m) => acc + m.length, 0));
  let offset = 0;
  for (const m of msgs) { combined.set(m, offset); offset += m.length; }
  const buf = await crypto.subtle.digest('SHA-512', combined);
  return new Uint8Array(buf);
};


// Original dashboard token (has operator.admin scope on the gateway)
const GATEWAY_RAW_TOKEN = "thanapat08";

// ─── Paired Device Identity (from ~/.openclaw/identity/device.json) ──────────

const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "webchat";

// base64url helpers
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const b64urlDecode = (str) => {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
};

// These are the existing CLI device credentials already paired with the gateway.
// deviceId = SHA-256 hex of the raw Ed25519 public key bytes
const PAIRED_DEVICE = {
  deviceId: "34e00f0ff24788b5c77675c9e2c6df47cbc8937ae42669fe42342a6f1787cf5a",
  publicKey: "8PfMP053v29aP2CSrvteviLMzTNuK_FtZebixdQj-VQ",   // raw Ed25519 pub key, base64url
  privateKey: "_PTDdTeBaHfe4DP3rq-tfFIw2lq2210I9H1Z0CL4Kzo",  // raw Ed25519 priv key, base64url
  deviceToken: "I5mUKLPxCubjK65BSl3-dL3BD2jT1TRC5GHKhpoZ5Bw", // from device-auth.json
};

async function buildDeviceIdentity({ serverNonce, role, scopes, token }) {
  const { deviceId, publicKey, privateKey } = PAIRED_DEVICE;
  const signedAtMs = Date.now(); // milliseconds
  const nonce = serverNonce || crypto.randomUUID();

  // Exact v2 message format from OpenClaw gateway source:
  // v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
  const scopesStr = scopes.join(",");
  const tokenStr = token ?? "";
  const message = ["v2", deviceId, CLIENT_ID, CLIENT_MODE, role, scopesStr, String(signedAtMs), tokenStr, nonce].join("|");

  // Sign with Ed25519
  const privBytes = b64urlDecode(privateKey);
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = await ed.signAsync(msgBytes, privBytes);

  return {
    id: deviceId,
    publicKey,
    signature: b64url(sigBytes),
    signedAt: signedAtMs,
    nonce,
  };
}

function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeAgent, setActiveAgent] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState('main'); // default: main agent for general chat
  const [pipelineMode, setPipelineMode] = useState(false); // false = direct chat, true = full pipeline

  // Pipeline agents definition (used in PIPELINE MODE)
  const PIPELINE = [
    { id: 'planner', label: 'นักล่าข่าวหุ้น', desc: 'ค้นข่าวหุ้น', color: 'text-blue-400', border: 'border-blue-500/50', bg: 'bg-blue-500/20' },
    { id: 'researcher', label: 'นักคิดลึก', desc: 'วิเคราะห์แนวโน้ม', color: 'text-purple-400', border: 'border-purple-500/50', bg: 'bg-purple-500/20' },
    { id: 'writer', label: 'นักเทรดมือฉมัง', desc: 'จำลองการเทรด', color: 'text-green-400', border: 'border-green-500/50', bg: 'bg-green-500/20' },
    { id: 'reviewer', label: 'ที่ปรึกษาสุดเบียว', desc: 'สรุปผลนำเสนอ', color: 'text-orange-400', border: 'border-orange-500/50', bg: 'bg-orange-500/20' },
  ];

  // All selectable agents for DIRECT CHAT (includes main + pipeline agents)
  const ALL_AGENTS = [
    { id: 'main', label: '🤖 Main', desc: 'แชททั่วไป', color: 'text-cyan-400', border: 'border-cyan-500/50', bg: 'bg-cyan-500/20' },
    ...PIPELINE,
  ];

  // Connection Settings
  const [endpoint, setEndpoint] = useState("ws://127.0.0.1:18789/");
  const [apiKey, setApiKey] = useState(GATEWAY_RAW_TOKEN);

  // Chat State
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [logs, setLogs] = useState([]);

  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev.slice(-199), { time, msg, type }]);
    const colors = { pipeline: 'color:#f97316', success: 'color:#4ade80', error: 'color:#f87171', info: 'color:#a1a1aa' };
    console.log(`%c[${time}] ${msg}`, colors[type] ?? colors.info);
  };

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);



  // ── Core helper: open WS, auth, send one message, stream response, resolve with full text ──
  const sendToAgentWS = (agentId, message, msgId, sessionId = 'main', timeoutMs = 90000) => {
    return new Promise((resolve, reject) => {
      let wsUrl = endpoint.trim();
      if (wsUrl.startsWith('http://')) wsUrl = wsUrl.replace('http://', 'ws://');
      else if (wsUrl.startsWith('https://')) wsUrl = wsUrl.replace('https://', 'wss://');
      else if (!wsUrl.startsWith('ws')) wsUrl = 'ws://' + wsUrl;

      const ws = new WebSocket(wsUrl);
      let accumulated = '';       // final resolved text
      let agentText = '';         // text from agent events
      let chatText = '';          // text from chat events
      let isAuthed = false;
      let done = false;
      let timeoutId = null;

      const finish = (result) => {
        if (done) return;
        done = true;
        if (timeoutId) clearTimeout(timeoutId);
        const text = result || '(ไม่มีข้อความตอบกลับ)';
        addLog(`✅ agent:${agentId} done (${text.length} chars)`, 'success');
        setMessages(prev => prev.map(m =>
          m.msgId === msgId ? { ...m, content: text, toolHint: null } : m
        ));
        ws.close();
        resolve(text);
      };

      // Safety-net timeout
      timeoutId = setTimeout(() => {
        if (!done) {
          addLog(`⏰ TIMEOUT agent:${agentId} after ${timeoutMs/1000}s — resolving with ${accumulated.length} chars`, 'error');
          finish(accumulated);
        }
      }, timeoutMs);

      const extractText = (payload) => {
        if (!payload) return '';
        // Format 1: message.content array [{type:"text", text:"..."}]
        if (payload.message?.content) {
          const arr = Array.isArray(payload.message.content)
            ? payload.message.content : [payload.message.content];
          const t = arr.filter(c => c?.type === 'text').map(c => c.text ?? c.content ?? '').join('');
          if (t) return t;
        }
        // Format 2: message.content is a plain string
        if (typeof payload.message?.content === 'string' && payload.message.content) return payload.message.content;
        // Format 3: direct content array
        if (Array.isArray(payload.content)) {
          const t = payload.content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('');
          if (t) return t;
        }
        // Format 4: direct content string
        if (typeof payload.content === 'string' && payload.content) return payload.content;
        // Format 5: payload.text
        if (typeof payload.text === 'string' && payload.text) return payload.text;
        // Format 6: message.text
        if (typeof payload.message?.text === 'string' && payload.message.text) return payload.message.text;
        // Format 7: payload.delta.content (OpenAI-style)
        if (typeof payload.delta?.content === 'string' && payload.delta.content) return payload.delta.content;
        // Format 8: payload.choices[0].delta.content
        if (payload.choices?.[0]?.delta?.content) return payload.choices[0].delta.content;
        // Format 9: payload.output
        if (typeof payload.output === 'string' && payload.output) return payload.output;
        // Format 10: payload.response
        if (typeof payload.response === 'string' && payload.response) return payload.response;
        return '';
      };

      const sendChat = () => {
        ws.send(JSON.stringify({
          type: 'req', id: 'msg-' + Date.now(), method: 'chat.send',
          params: {
            sessionKey: `agent:${agentId}:${sessionId}`,
            message,
            idempotencyKey: 'idem-' + Date.now() + '-' + Math.random().toString(36).slice(2)
          }
        }));
      };

      ws.onopen = () => {
        addLog(`🔌 WS connected → agent:${agentId}`, 'info');
      };

      ws.onmessage = async (event) => {
        if (done) return;
        try {
          const data = JSON.parse(event.data);

          if (data.event === 'health' || data.event === 'tick') return;

          // Debug: log every non-trivial event
          if (data.event && !['health','tick'].includes(data.event)) {
            addLog(`📡 [${agentId}] event:${data.event} state:${data.payload?.state ?? '-'} type:${data.payload?.type ?? '-'}`, 'info');
          }

          if (data.type === 'event' && data.event === 'connect.challenge') {
            ws.send(JSON.stringify({
              type: 'req', id: 'req-auth-' + Date.now(), method: 'connect',
              params: {
                minProtocol: 3, maxProtocol: 3,
                client: {
                  id: 'openclaw-control-ui', version: 'control-ui', mode: 'webchat',
                  platform: navigator.platform ?? 'web', instanceId: crypto.randomUUID()
                },
                role: 'operator',
                scopes: ['operator.read', 'operator.write', 'operator.admin'],
                caps: ['tool-events'],
                auth: { token: apiKey },
                userAgent: navigator.userAgent, locale: navigator.language,
              }
            }));
            return;
          }

          if (data.type === 'event' && data.event === 'connect.authenticated') {
            if (data.payload?.ok) {
              addLog(`🔐 Authed → agent:${agentId}`, 'success');
              isAuthed = true; sendChat();
            } else reject(new Error('Auth rejected'));
            return;
          }

          if (data.type === 'res' && data.ok === true && !isAuthed) {
            isAuthed = true; sendChat(); return;
          }

          if ((data.type === 'res' && data.ok === false) ||
            (data.type === 'event' && data.event === 'error')) {
            reject(new Error(data.error?.message || data.payload?.message || JSON.stringify(data)));
            ws.close(); return;
          }

          // ── Tool events: show live progress indicator ──
          if (data.type === 'event' && data.event === 'tool') {
            const toolName = data.payload?.name ?? data.payload?.tool ?? '...';
            const toolState = data.payload?.state ?? '';
            if (toolState !== 'final') {
              setMessages(prev => prev.map(m =>
                m.msgId === msgId ? { ...m, toolHint: `⚙️ ${toolName}` } : m
              ));
            }
            return;
          }

          const isAgent = data.type === 'event' && data.event === 'agent' && data.payload;
          const isChat = data.type === 'event' && data.event === 'chat' && data.payload;
          if (!isAgent && !isChat) return;

          const p = data.payload;
          const text = extractText(p);
          // Accept multiple "final" state values from different gateway versions
          const FINAL_STATES = ['final', 'complete', 'done', 'finished', 'end'];
          const isFinal = FINAL_STATES.includes(p.state?.toLowerCase?.()) ||
            (isChat && p.state === 'final') ||
            (data.event === 'agent' && p.state === 'final');

          // Debug: log payload summary when no text extracted, to help diagnose writer issues
          if (!text && (isAgent || isChat)) {
            addLog(`🔍 [${agentId}] no-text payload: state=${p.state} keys=${Object.keys(p).join(',')}`, 'info');
          }

          // Clear tool hint once agent starts streaming text
          if (isAgent && text) {
            setMessages(prev => prev.map(m =>
              m.msgId === msgId ? { ...m, toolHint: null } : m
            ));
          }

          // Agent events send CUMULATIVE text (full text so far) — use REPLACE, not append
          if (isAgent && !isFinal && text) {
            agentText = text;
            accumulated = agentText;
            setMessages(prev => prev.map(m =>
              m.msgId === msgId ? { ...m, content: accumulated } : m
            ));
          }

          // Also capture agent final text
          if (isAgent && isFinal && text) {
            agentText = text;
          }

          // Chat events: only use the FINAL event which has the definitive full text
          if (isChat && isFinal && text) {
            chatText = text;
          }

          if (isFinal) {
            const best = agentText.length >= chatText.length ? agentText : chatText;
            finish(best);
          }
        } catch (e) {
          if (timeoutId) clearTimeout(timeoutId);
          done = true;
          reject(e); ws.close();
        }
      };

      ws.onerror = () => {
        if (!done) {
          addLog(`❌ WS error: agent:${agentId}`, 'error');
          if (timeoutId) clearTimeout(timeoutId);
          done = true;
          reject(new Error(`WebSocket error for agent:${agentId}`));
        }
      };
      ws.onclose = () => {
        // Safety-net: if WS closed before final event was caught, resolve with what we have
        if (!done) {
          if (timeoutId) clearTimeout(timeoutId);
          done = true;
          addLog(`🔴 WS closed without final — resolving with ${accumulated.length} chars`, 'info');
          resolve(accumulated || '(ไม่มีข้อความตอบกลับ)');
        }
      };
    });
  };

  // ── Pipeline orchestrator: News Hunter → Analyst → Trader ⟲ → Advisor ──
  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userInput = input.trim();
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setMessages(prev => [...prev, { role: 'user', content: userInput }]);
    setIsLoading(true);

    // ── DIRECT CHAT MODE: send to one selected agent only ──
    if (!pipelineMode) {
      try {
        addLog(`💬 Direct Chat → agent:${selectedAgent}`, 'info');
        setActiveAgent(selectedAgent);
        const agent = PIPELINE.find(a => a.id === selectedAgent);
        const mid = 'msg-' + Date.now();
        setMessages(prev => [...prev, {
          msgId: mid, role: 'assistant', content: '',
          agentId: selectedAgent, agentLabel: agent?.label ?? 'P meow'
        }]);
        const result = await sendToAgentWS(selectedAgent, userInput, mid);
        const isEmpty = !result || result === '(ไม่มีข้อความตอบกลับ)';
        if (isEmpty) {
          addLog(`⚠️ agent:${selectedAgent} ไม่มีคำตอบ — ลอง reload หรือตรวจ OpenClaw`, 'error');
          setMessages(prev => prev.map(m => m.msgId === mid ? { ...m, content: '⚠️ **ไม่ได้รับคำตอบ** — กรุณาตรวจสอบว่า OpenClaw Gateway กำลังรันอยู่\nหรือลอง reload หน้าแล้วส่งใหม่อีกครั้ง', isError: true } : m));
        }
        addLog(`✅ Direct Chat done`, 'success');
      } catch (err) {
        addLog(`❌ Direct Chat error: ${err.message}`, 'error');
        setMessages(prev => [...prev, {
          role: 'assistant', content: `❌ Error: ${err.message}`, isError: true
        }]);
      } finally {
        setActiveAgent(null);
        setIsLoading(false);
      }
      return;
    }

    // ── PIPELINE MODE: full 4-agent chain ──
    const LOSS_KEYWORDS = /ขาดทุน|loss|❌.*ขาด|ไม่ควรซื้อ|ไม่แนะนำ.*เทรด/i;
    const MAX_LOOPS = 3;
    const runId = 'run-' + Date.now(); // unique session per pipeline run
    try {
      let loopCount = 0;
      let newsData = '', analysisData = '';

      while (loopCount < MAX_LOOPS) {
        // ─── Stage 1: News Hunter ───────────────────────────────────────────
        addLog(`📄 Loop ${loopCount + 1} — Stage 1: นักข่าวหุ้น`, 'pipeline');
        setActiveAgent('planner');
        const mid1 = 'p1-' + Date.now();
        setMessages(prev => [...prev,
        {
          msgId: mid1, role: 'assistant', content: '', agentId: 'planner',
          agentLabel: '📰 นักข่าวหุ้น'
        }]);

        const loopMsg = loopCount > 0
          ? `รอบที่ ${loopCount + 1}: ผลเทรดขาดทุน กรุณาค้นข้อมูลใหม่สำหรับหุ้น: ${userInput}`
          : userInput;
        newsData = await sendToAgentWS('planner', loopMsg, mid1, runId);

        // ─── Stage 2: Analyst ───────────────────────────────────────────────
        addLog('📊 Stage 2: นักวิเคราะห์', 'pipeline');
        setActiveAgent('researcher');
        const mid2 = 'p2-' + Date.now();
        setMessages(prev => [...prev,
        {
          msgId: mid2, role: 'assistant', content: '', agentId: 'researcher',
          agentLabel: '📊 นักวิเคราะห์'
        }]);

        analysisData = await sendToAgentWS('researcher',
          `📰 ข่าวหุ้นจากนักข่าวหุ้น:
${newsData}

ให้วิเคราะห์บนข้อมูลนี้`, mid2, runId);

        // ─── Stage 3: Trader Simulator ──────────────────────────────────────
        addLog('💹 Stage 3: นักเทรดจำลอง', 'pipeline');
        setActiveAgent('writer');
        const mid3 = 'p3-' + Date.now();
        setMessages(prev => [...prev,
        {
          msgId: mid3, role: 'assistant', content: '', agentId: 'writer',
          agentLabel: '💹 นักเทรดจำลอง'
        }]);

        const tradeResult = await sendToAgentWS('writer',
          `📰 ข่าว:
${newsData}

📊 วิเคราะห์:
${analysisData}

จำลองซื้อด้วยเงิน 100,000 บาท`, mid3, runId);

        const isLoss = LOSS_KEYWORDS.test(tradeResult);

        if (isLoss && loopCount < MAX_LOOPS - 1) {
          loopCount++;
          addLog(`⚠️ ขาดทุน — วนรอบที่ ${loopCount + 1}`, 'error');
          setMessages(prev => [...prev, {
            role: 'assistant', content:
              `🔄 รอบที่ ${loopCount + 1}: พบสัญญาณขาดทุน — กำลังค้นหาข้อมูลใหม่...`,
            agentId: 'writer', agentLabel: '💹 นักเทรดจำลอง'
          }]);
          continue;
        }

        // ─── Stage 4: Investment Advisor (ALWAYS runs) ──────────────────────
        addLog(`🎯 Stage 4: ที่ปรึกษาลงทุน${isLoss ? ' (สัญญาณขาดทุน)' : ' (กำไร!)'}`, 'pipeline');
        setActiveAgent('reviewer');
        const mid4 = 'p4-' + Date.now();
        setMessages(prev => [...prev,
        {
          msgId: mid4, role: 'assistant', content: '', agentId: 'reviewer',
          agentLabel: '🎯 ที่ปรึกษาลงทุน'
        }]);

        const advisorResult = await sendToAgentWS('reviewer',
          `📰 ข่าว:
${newsData}

📊 วิเคราะห์:
${analysisData}

💹 ผลเทรดจำลอง:
${tradeResult}${isLoss ? `

⚠️ หมายเหตุ: วิเคราะห์ ${loopCount + 1} รอบแล้ว ยังพบสัญญาณขาดทุน` : ''}

สรุปภาพรวมและให้คำแนะนำการลงทุน`, mid4, runId);

        // Fallback: if reviewer returns NO_RE / empty, inject auto-summary
        const isNoResponse = !advisorResult || /^(NO_RE|NO_RESPONSE|\(ไม่มีข้อความตอบกลับ\))$/i.test(advisorResult.trim());
        if (isNoResponse) {
          addLog('⚠️ Reviewer ไม่ตอบ — แสดง fallback summary', 'error');
          const fallback = `📊 **สรุปการวิเคราะห์**\n━━━━━━━━━━━━━━━━\n💹 **เทรดจำลอง:** ${tradeResult.slice(0, 300)}\n━━━━━━━━━━━━━━━━\n🎯 **คำแนะนำ:** ${isLoss ? 'หลีกเลี่ยง — พบสัญญาณขาดทุน' : 'รอดูสัญญาณเพิ่มเติม'}\n⚠️ **Risk:** ${isLoss ? '🔴 สูง' : '🟡 ปานกลาง'}\n━━━━━━━━━━━━━━━━\n_⚠️ Disclaimer: ข้อมูลนี้เพื่อประกอบการตัดสินใจเท่านั้น_`;
          setMessages(prev => prev.map(m => m.msgId === mid4 ? { ...m, content: fallback } : m));
        }

        break; // pipeline complete
      }
    } catch (error) {
      addLog(`❌ Pipeline Error: ${error.message}`, 'error');
      console.error('Pipeline Error:', error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `❌ Pipeline Error: ${error.message}`,
        isError: true
      }]);
    } finally {
      setActiveAgent(null);
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  const TICKERS = [
    { sym: 'SET', val: '1,421', chg: '+0.54%', up: true },
    { sym: 'BTC/USD', val: '84,312', chg: '+2.14%', up: true },
    { sym: 'ETH/USD', val: '3,241', chg: '+1.87%', up: true },
    { sym: 'NVDA', val: '875.22', chg: '-0.43%', up: false },
    { sym: 'AAPL', val: '189.54', chg: '+0.92%', up: true },
    { sym: 'TSLA', val: '177.80', chg: '-1.22%', up: false },
    { sym: 'GOLD', val: '2,318', chg: '+0.11%', up: true },
    { sym: 'USD/JPY', val: '151.44', chg: '-0.22%', up: false },
    { sym: 'SPY', val: '519.41', chg: '+0.31%', up: true },
    { sym: 'QQQ', val: '436.85', chg: '+0.58%', up: true },
  ];

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: '#060e1a', color: '#c8d8e8', fontFamily: "'Inter','Segoe UI',sans-serif" }}>

      {/* ── Ticker Bar ── */}
      <div className="flex-shrink-0 overflow-hidden border-b" style={{ borderColor: '#1a2e44', background: '#080f1c', height: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', height: '100%', width: 'max-content', animation: 'tickerScroll 40s linear infinite' }}>
          {[...TICKERS, ...TICKERS].map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 px-4 text-[11px] font-mono border-r" style={{ borderColor: '#1a2e44', height: '100%', whiteSpace: 'nowrap' }}>
              <span style={{ color: '#7da8cc', fontWeight: 700 }}>{t.sym}</span>
              <span style={{ color: '#e8f4ff', fontWeight: 600 }}>{t.val}</span>
              <span style={{ color: t.up ? '#00d084' : '#ff5252' }}>{t.chg}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* Mobile overlay */}
        {isSidebarOpen && <div className="fixed inset-0 z-20" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setIsSidebarOpen(false)} />}

        {/* ── Sidebar ── */}
        <aside className={`fixed inset-y-0 left-0 w-72 z-30 flex flex-col border-r transform transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
          style={{ top: '28px', background: '#080f1c', borderColor: '#1a2e44' }}>
          <div className="flex justify-between items-center px-4 py-3 border-b flex-shrink-0" style={{ borderColor: '#1a2e44' }}>
            <div className="flex items-center gap-2 text-[12px] font-bold tracking-widest" style={{ color: '#00d084' }}>
              <Settings2 className="w-3.5 h-3.5" />GATEWAY CONFIG
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="p-1 rounded hover:bg-white/5" style={{ color: '#7da8cc' }}><X className="w-4 h-4" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="block text-[10px] font-bold mb-1.5 tracking-widest" style={{ color: '#00d084' }}>ENDPOINT</label>
              <input type="text" value={endpoint} onChange={e => setEndpoint(e.target.value)}
                className="w-full text-[12px] px-3 py-2 rounded font-mono focus:outline-none border"
                style={{ background: '#0d1b2a', borderColor: '#1e3a5f', color: '#c8d8e8' }} placeholder="ws://127.0.0.1:18789/" />
            </div>
            <div>
              <label className="block text-[10px] font-bold mb-1.5 tracking-widest" style={{ color: '#00d084' }}>TOKEN</label>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                className="w-full text-[12px] px-3 py-2 rounded font-mono focus:outline-none border"
                style={{ background: '#0d1b2a', borderColor: '#1e3a5f', color: '#c8d8e8' }} placeholder="03e4..." />
            </div>
            <div>
              <div className="text-[10px] font-bold tracking-widest mb-2" style={{ color: '#00d084' }}>WATCHLIST</div>
              {TICKERS.slice(0, 7).map(t => (
                <div key={t.sym} className="flex justify-between items-center py-2 border-b" style={{ borderColor: '#0d1b2a' }}>
                  <span className="text-[12px] font-bold" style={{ color: '#c8d8e8' }}>{t.sym}</span>
                  <div className="text-right">
                    <div className="text-[12px] font-mono font-semibold text-white">{t.val}</div>
                    <div className="text-[10px]" style={{ color: t.up ? '#00d084' : '#ff5252' }}>{t.chg}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Logs */}
          <div className="border-t flex flex-col flex-shrink-0" style={{ borderColor: '#1a2e44', height: '190px' }}>
            <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0" style={{ borderColor: '#1a2e44' }}>
              <span className="text-[10px] font-bold tracking-widest" style={{ color: '#00d084' }}>▶ SYSTEM LOG</span>
              <button onClick={() => setLogs([])} className="text-[10px] hover:text-white" style={{ color: '#2a4a6a' }}>CLEAR</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-0.5 font-mono">
              {logs.length === 0 && <p className="text-[10px] italic" style={{ color: '#1e3a5f' }}>no logs yet...</p>}
              {logs.map((log, i) => (
                <div key={i} className="text-[10px]">
                  <span style={{ color: '#1e3a5f' }}>[{log.time}]</span>{' '}
                  <span style={{ color: log.type === 'error' ? '#ff5252' : log.type === 'success' ? '#00d084' : log.type === 'pipeline' ? '#ffa500' : '#7da8cc' }}>{log.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* ── Main Area ── */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* Header */}
          <header className="flex-shrink-0 flex items-center justify-between px-4 border-b" style={{ height: '48px', background: '#080f1c', borderColor: '#1a2e44' }}>
            <div className="flex items-center gap-3">
              <button onClick={() => setIsSidebarOpen(true)} className="p-1.5 rounded hover:bg-white/5" style={{ color: '#7da8cc' }}>
                <Menu className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded flex items-center justify-center text-[11px] font-bold" style={{ background: '#00d084', color: '#060e1a' }}>HUN</div>
                <span className="font-bold text-sm tracking-wide" style={{ color: '#c8d8e8' }}>HunHunSahurrrr</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: '#00d08420', color: '#00d084', border: '1px solid #00d08440' }}>▲ LIVE</span>
              </div>
            </div>
            <div className="text-[11px] px-2.5 py-1 rounded font-mono border flex items-center gap-1.5" style={{ background: '#0d1b2a', borderColor: '#1e3a5f', color: '#7da8cc' }}>
              <span className="w-1.5 h-1.5 rounded-full inline-block animate-pulse" style={{ background: '#00d084' }} />
              ptm-minimax-2.5
            </div>
          </header>

          {/* Pipeline Bar */}
          <div className="flex-shrink-0 flex items-center gap-2 px-4 border-b" style={{ height: '40px', background: '#080f1c', borderColor: '#1a2e44' }}>
            <button onClick={() => setPipelineMode(m => !m)}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-bold border flex-shrink-0 transition-all"
              style={pipelineMode ? { background: '#ffa50020', color: '#ffa500', borderColor: '#ffa50060' } : { background: '#0d1b2a', color: '#7da8cc', borderColor: '#1e3a5f' }}>
              {pipelineMode ? '⛓ PIPELINE' : '💬 DIRECT'}
            </button>
            <span style={{ color: '#1a2e44', fontSize: '10px' }}>│</span>
            <div className="flex items-center gap-1.5 flex-1 justify-center">
              {(pipelineMode ? PIPELINE : ALL_AGENTS).map((agent, i, arr) => {
                const isSelected = selectedAgent === agent.id;
                const isWorking = isLoading && activeAgent === agent.id;
                const ac = { main: { a: '#22d3ee', bg: '#22d3ee20', b: '#22d3ee60' }, planner: { a: '#4a9eff', bg: '#4a9eff20', b: '#4a9eff60' }, researcher: { a: '#a855f7', bg: '#a855f720', b: '#a855f760' }, writer: { a: '#00d084', bg: '#00d08420', b: '#00d08460' }, reviewer: { a: '#ffa500', bg: '#ffa50020', b: '#ffa50060' } }[agent.id] ?? { a: '#7da8cc', bg: '#7da8cc20', b: '#7da8cc60' };
                return (
                  <div key={agent.id} className="flex items-center gap-1.5">
                    <button onClick={() => setSelectedAgent(agent.id)} title={agent.desc}
                      className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold border transition-all"
                      style={isWorking || (isSelected && !pipelineMode) ? { background: ac.bg, color: ac.a, borderColor: ac.b } : { background: '#0d1b2a', color: '#3a5a7a', borderColor: '#1a2e44' }}>
                      {isWorking && <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block mr-1" style={{ background: ac.a }} />}
                      {agent.label}
                    </button>
                    {i < arr.length - 1 && <span style={{ color: pipelineMode ? '#ffa50050' : '#1a2e44', fontSize: '10px' }}>›</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto" style={{ background: '#060e1a' }}>
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <div className="text-5xl mb-5">📈</div>
                <p className="text-xl font-bold mb-2" style={{ color: '#c8d8e8' }}>HunHunSahurrrr พร้อมให้คำปรึกษา</p>
                <p className="text-sm mb-8" style={{ color: '#3a5a7a' }}>ถามเกี่ยวกับหุ้น, crypto, forex หรือตลาดการลงทุนได้เลย</p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {['วิเคราะห์ SET Index วันนี้', 'แนวโน้ม BTC ระยะสั้น', 'หุ้น Growth ที่น่าสนใจ', 'กลยุทธ์ DCA คืออะไร'].map(s => (
                    <button key={s} onClick={() => setInput(s)}
                      className="px-4 py-2 rounded-full text-sm border transition-all hover:border-green-500/40"
                      style={{ background: '#0d1b2a', borderColor: '#1e3a5f', color: '#7da8cc' }}>{s}</button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col pb-4">
                {messages.map((msg, idx) => (
                  <div key={idx} className="px-4 py-4 md:px-8 border-b"
                    style={{ borderColor: '#0d1b2a', background: msg.role === 'assistant' ? '#080f1c' : 'transparent' }}>
                    <div className="max-w-3xl mx-auto flex gap-4">
                      <div className="flex-shrink-0 mt-0.5">
                        {msg.role === 'user' ? (
                          <div className="w-7 h-7 rounded flex items-center justify-center" style={{ background: '#1e3a5f', color: '#7da8cc' }}>
                            <User className="w-3.5 h-3.5" />
                          </div>
                        ) : (
                          <div className="w-7 h-7 rounded flex items-center justify-center text-[11px] font-bold" style={{ background: '#00d08420', color: '#00d084', border: '1px solid #00d08440' }}>AI</div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold mb-1.5 flex items-center gap-2">
                          {msg.role === 'user' ? (<span style={{ color: '#7da8cc' }}>YOU</span>) : (
                            <>
                              <span style={{ color: '#00d084' }}>{msg.agentLabel ?? 'AI ANALYST'}</span>
                              {msg.agentId && PIPELINE.find(a => a.id === msg.agentId) && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: '#0d1b2a', color: '#3a5a7a', border: '1px solid #1a2e44' }}>
                                  {PIPELINE.find(a => a.id === msg.agentId)?.desc}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                        {/* Tool-use indicator for main agent */}
                        {msg.toolHint && !msg.content && (
                          <div className="text-[11px] font-mono animate-pulse mb-1" style={{ color: '#22d3ee' }}>
                            {msg.toolHint}
                          </div>
                        )}
                        <div className="text-sm leading-relaxed"
                          style={{ color: msg.isError ? '#ff5252' : msg.role === 'user' ? '#c8d8e8' : '#a8c8e8' }}>
                          {msg.content ? (
                            msg.role === 'user' ? (
                              <span className="whitespace-pre-wrap font-mono">{msg.content}</span>
                            ) : (
                              <div className="markdown-body">
                                <ReactMarkdown
                                  components={{
                                    h1: ({children}) => <h1 style={{color:'#00d084',fontSize:'1.15em',fontWeight:700,margin:'0.6em 0 0.3em',borderBottom:'1px solid #1a2e44',paddingBottom:'0.2em'}}>{children}</h1>,
                                    h2: ({children}) => <h2 style={{color:'#4a9eff',fontSize:'1.05em',fontWeight:700,margin:'0.5em 0 0.25em'}}>{children}</h2>,
                                    h3: ({children}) => <h3 style={{color:'#a8c8e8',fontSize:'0.95em',fontWeight:700,margin:'0.4em 0 0.2em'}}>{children}</h3>,
                                    strong: ({children}) => <strong style={{color:'#e8f4ff',fontWeight:700}}>{children}</strong>,
                                    em: ({children}) => <em style={{color:'#c8d8e8',fontStyle:'italic'}}>{children}</em>,
                                    p: ({children}) => <p style={{margin:'0.3em 0',lineHeight:'1.6'}}>{children}</p>,
                                    ul: ({children}) => <ul style={{margin:'0.3em 0',paddingLeft:'1.4em',listStyleType:'disc'}}>{children}</ul>,
                                    ol: ({children}) => <ol style={{margin:'0.3em 0',paddingLeft:'1.4em'}}>{children}</ol>,
                                    li: ({children}) => <li style={{margin:'0.15em 0',lineHeight:'1.6'}}>{children}</li>,
                                    code: ({children}) => <code style={{background:'#0d1b2a',color:'#00d084',padding:'0.1em 0.4em',borderRadius:'3px',fontFamily:'monospace',fontSize:'0.9em'}}>{children}</code>,
                                    pre: ({children}) => <pre style={{background:'#0d1b2a',padding:'0.7em 1em',borderRadius:'6px',overflowX:'auto',margin:'0.4em 0',border:'1px solid #1a2e44',fontFamily:'monospace',fontSize:'0.85em',color:'#00d084'}}>{children}</pre>,
                                    blockquote: ({children}) => <blockquote style={{borderLeft:'3px solid #00d084',paddingLeft:'0.8em',margin:'0.3em 0',color:'#7da8cc',fontStyle:'italic'}}>{children}</blockquote>,
                                    hr: () => <hr style={{border:'none',borderTop:'1px solid #1a2e44',margin:'0.5em 0'}} />,
                                    a: ({href, children}) => <a href={href} target="_blank" rel="noreferrer" style={{color:'#4a9eff',textDecoration:'underline'}}>{children}</a>,
                                  }}
                                >{msg.content}</ReactMarkdown>
                              </div>
                            )
                          ) : <span className="animate-pulse" style={{ color: '#3a5a7a' }}>▌</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="px-4 py-4 md:px-8 border-b" style={{ borderColor: '#0d1b2a', background: '#080f1c' }}>
                    <div className="max-w-3xl mx-auto flex gap-4 items-center">
                      <div className="w-7 h-7 rounded flex items-center justify-center text-[11px] font-bold flex-shrink-0" style={{ background: '#00d08420', color: '#00d084', border: '1px solid #00d08440' }}>AI</div>
                      <span className="text-[11px] font-mono mr-2" style={{ color: '#3a5a7a' }}>
                        {activeAgent ? `${PIPELINE.find(a => a.id === activeAgent)?.label ?? activeAgent} กำลังวิเคราะห์...` : 'กำลังประมวลผล...'}
                      </span>
                      {[0, 1, 2].map(n => <div key={n} className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: '#00d084', animationDelay: `${n * 150}ms` }} />)}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} className="h-4" />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="flex-shrink-0 p-4 border-t" style={{ background: '#080f1c', borderColor: '#1a2e44' }}>
            <div className="max-w-3xl mx-auto flex items-end gap-2 rounded border px-3 py-2 transition-all focus-within:border-green-500/40"
              style={{ background: '#0d1b2a', borderColor: '#1e3a5f' }}>
              <span className="text-sm font-bold flex-shrink-0 mb-1" style={{ color: '#00d084' }}>▶</span>
              <textarea ref={textareaRef} value={input} onChange={handleInput} onKeyDown={handleKeyDown}
                placeholder="ถามเกี่ยวกับหุ้น, crypto, forex หรือตลาดการลงทุน..."
                rows={1} className="flex-1 bg-transparent resize-none focus:outline-none text-sm leading-relaxed max-h-40 overflow-y-auto font-mono"
                style={{ color: '#c8d8e8' }} />
              <button onClick={handleSend} disabled={!input.trim() || isLoading}
                className="p-2 rounded flex-shrink-0 self-end transition-all"
                style={!input.trim() || isLoading ? { background: '#1a2e44', color: '#3a5a7a' } : { background: '#00d084', color: '#060e1a' }}>
                <Send className="w-4 h-4" />
              </button>
            </div>
            <div className="text-center text-[10px] mt-2 font-mono" style={{ color: '#1e3a5f' }}>
              {endpoint} · {pipelineMode ? 'PIPELINE MODE' : 'DIRECT MODE'}
            </div>
          </div>
        </main>
      </div>

      <style>{`@keyframes tickerScroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

export default App;

