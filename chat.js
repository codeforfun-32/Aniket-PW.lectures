// ==========================================
// CONFIGURATION
// ==========================================
// WARNING: anything in front-end JS is public. Put a NEW key here only for
// local testing, and restrict it in Google AI Studio / Cloud Console
// (HTTP referrer restriction). Long-term, call Gemini from a small backend.
const GEMINI_API_KEY = "AIzaSyAZvg7xt7gfyqv4YWy7vGGqwmlsodioTjU";

// Tried in order. If one is overloaded (503) the next one is used.
const MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
const MAX_RETRIES_PER_MODEL = 1;   // extra tries after the first one
const REQUEST_TIMEOUT_MS = 20000;  // give up on a single request after 20s
const RETRY_DELAY_MS = 1000;       // doubles each retry

// Backup provider (free): get a key at https://openrouter.ai/keys
// "openrouter/free" automatically picks a free model that supports images.
const OPENROUTER_API_KEY = "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";
const OPENROUTER_MODEL = "openrouter/free";

function apiUrl(model) {
    return "https://generativelanguage.googleapis.com/v1beta/models/" + model +
           ":generateContent?key=" + GEMINI_API_KEY.trim();
}

// ==========================================
// STATE
// ==========================================
// Stores the conversation history so Gemini remembers context
let chatHistory = []; 
let pendingImageBase64 = null;
let pendingImageMimeType = null;
let msgCounter = 0;

// ==========================================
// DOM ELEMENTS
// ==========================================
const fullChatMessages = document.getElementById('fullChatMessages');
const fullChatInput = document.getElementById('fullChatInput');
const fullChatSendBtn = document.getElementById('fullChatSendBtn');

const overlayChatMessages = document.getElementById('overlayChatMessages');
const overlayChatInput = document.getElementById('overlayChatInput');
const overlayChatSendBtn = document.getElementById('overlayChatSendBtn');

// ==========================================
// EVENT LISTENERS
// ==========================================

// 1. Click events for Send buttons
fullChatSendBtn.addEventListener('click', () => handleSendClick('full'));
overlayChatSendBtn.addEventListener('click', () => handleSendClick('overlay'));

// 2. Enter key events for Input fields
fullChatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSendClick('full');
});
overlayChatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSendClick('overlay');
});

// 3. Paste events for capturing screenshots (Ctrl+V)
fullChatInput.addEventListener('paste', handleImagePaste);
overlayChatInput.addEventListener('paste', handleImagePaste);


// ==========================================
// CORE FUNCTIONS
// ==========================================

async function handleSendClick(source) {
    const inputEl = source === 'full' ? fullChatInput : overlayChatInput;
    const text = inputEl.value.trim();
    
    // Don't send if empty and no image attached
    if (!text && !pendingImageBase64) return;
    
    // Clear inputs and placeholders
    fullChatInput.value = '';
    overlayChatInput.value = '';
    resetInputPlaceholder();

    // 1. Add User Message to UI
    appendMessageToUI(text, 'user', pendingImageBase64);

    // 2. Prepare the parts array for the API
    const userParts = [];
    if (text) {
        userParts.push({ text: text });
    }
    if (pendingImageBase64) {
        userParts.push({
            inline_data: {
                mime_type: pendingImageMimeType,
                data: pendingImageBase64
            }
        });
    }

    // 3. Add to internal history
    chatHistory.push({ role: 'user', parts: userParts });

    // Clear pending image now that it's queued
    pendingImageBase64 = null;
    pendingImageMimeType = null;

    // 4. Show loading indicator
    const loadingId = appendMessageToUI("Thinking...", 'ai');

    try {
        // 5. Call Gemini API
        const responseText = await fetchGeminiResponse(loadingId);
        
        // 6. Update internal history with AI response
        chatHistory.push({ role: 'model', parts: [{ text: responseText }] });
        
        // 7. Update UI
        updateMessageInUI(loadingId, responseText);
    } catch (error) {
        console.error("Gemini API Error details:", error);
        updateMessageInUI(loadingId, `⚠️ Error: ${error.message}. Open console (F12) for details.`);
        // Pop the user message from history so they can try again without breaking context
        if (chatHistory.length > 0) chatHistory.pop(); 
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));


// Converts our Gemini-style history to OpenAI format and asks OpenRouter
// The free router sometimes picks a safety-checker model that replies with
// "User Safety: safe..." instead of an answer. Detect that and ask again.
function looksLikeSafetyCheck(text) {
    return /^\s*User Safety:/i.test(text) || /^\s*Response Safety:/i.test(text);
}

async function fetchOpenRouterResponse() {
    for (let i = 0; i < 4; i++) {
        const text = await fetchOpenRouterOnce();
        if (!looksLikeSafetyCheck(text)) return text;
        console.warn("OpenRouter picked a safety-checker model, retrying...", text);
    }
    throw new Error("OpenRouter kept returning a non-chat model; try Gemini mode");
}

async function fetchOpenRouterOnce() {
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.startsWith("PASTE_")) {
        throw new Error("Gemini is busy and no OpenRouter backup key is set");
    }
    const messages = chatHistory.map(turn => ({
        role: turn.role === 'model' ? 'assistant' : 'user',
        content: turn.parts.map(p => p.text !== undefined
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } })
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + OPENROUTER_API_KEY.trim()
            },
            body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: 4096 }),
            signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || `OpenRouter HTTP ${response.status}`);
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error("OpenRouter returned an empty response");
        return text;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchFromGemini(statusMsgId) {
    const payload = {
        contents: chatHistory,
        generationConfig: { maxOutputTokens: 8192 }
    };

    let lastError = new Error("Unknown error");

    for (const model of MODELS) {
        for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
            try {
                if (statusMsgId) {
                    updateMessageInUI(statusMsgId, `Thinking... (${model}${attempt ? ', retry ' + attempt : ''})`);
                }
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                let response, data;
                try {
                    response = await fetch(apiUrl(model), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                    data = await response.json();
                } finally {
                    clearTimeout(timer);
                }

                if (response.ok) {
                    const parts = data.candidates?.[0]?.content?.parts;
                    if (!parts) {
                        const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || "no content";
                        throw new Error("Empty response (" + reason + ")");
                    }
                    // Join all text parts (thinking models may return several)
                    return parts.map(p => p.text || '').join('');
                }

                const msg = data.error ? data.error.message : `HTTP status ${response.status}`;
                lastError = new Error(msg);

                // Temporary problems (overloaded / rate limited) -> retry, then fall back
                if ([429, 500, 503, 504].includes(response.status)) {
                    console.warn(`${model} attempt ${attempt + 1} failed (${response.status}): ${msg}`);
                    if (attempt < MAX_RETRIES_PER_MODEL) await sleep(RETRY_DELAY_MS * 2 ** attempt);
                    continue;
                }
                // 404 = model not found -> try next model; anything else (400/403) is a real bug
                if (response.status === 404) break;
                throw lastError;
            } catch (err) {
                if (err instanceof TypeError || err.name === 'AbortError') { // network failure / timeout
                    lastError = err;
                    if (attempt < MAX_RETRIES_PER_MODEL) await sleep(RETRY_DELAY_MS * 2 ** attempt);
                    continue;
                }
                throw err;
            }
        }
    }
    throw lastError;
}


// ==========================================
// MODEL MODE (dropdown)
//   fast   -> OpenRouter only (no waiting on Gemini)
//   gemini -> Gemini only (with retries)
//   both   -> Gemini first, OpenRouter as backup
// ==========================================
let modelMode = 'both';
try { modelMode = localStorage.getItem('chatModelMode') || 'both'; } catch (e) {}

function setModelMode(mode) {
    modelMode = mode;
    try { localStorage.setItem('chatModelMode', mode); } catch (e) {}
    document.querySelectorAll('.model-mode-select').forEach(sel => sel.value = mode);
}
document.querySelectorAll('.model-mode-select').forEach(sel => {
    sel.addEventListener('change', () => setModelMode(sel.value));
});
setModelMode(modelMode);

async function fetchGeminiResponse(statusMsgId) {
    if (modelMode === 'fast') {
        if (statusMsgId) updateMessageInUI(statusMsgId, "Thinking... (fast mode)");
        return await fetchOpenRouterResponse();
    }
    if (modelMode === 'gemini') {
        return await fetchFromGemini(statusMsgId);
    }
    // 'both'
    try {
        return await fetchFromGemini(statusMsgId);
    } catch (geminiErr) {
        console.warn("Gemini failed, trying backup:", geminiErr);
        try {
            if (statusMsgId) updateMessageInUI(statusMsgId, "Gemini is busy, trying backup (OpenRouter)...");
            return await fetchOpenRouterResponse();
        } catch (backupErr) {
            throw new Error(geminiErr.message + " | Backup: " + backupErr.message);
        }
    }
}

// ==========================================
// UI RENDERING
// ==========================================


// ==========================================
// RICH TEXT (Markdown + LaTeX math)
// ==========================================
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderRichText(text) {
    // Fallback if the libraries failed to load
    if (typeof marked === 'undefined' || typeof katex === 'undefined' || typeof DOMPurify === 'undefined') {
        return escapeHtml(text).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    }

    // 1. Pull math out so markdown can't mangle it (_, \, * etc.)
    const maths = [];
    const stash = (tex, display) => {
        maths.push({ tex: tex.trim(), display });
        const token = 'MATHTOKEN' + (maths.length - 1) + 'ENDTOKEN';
        return display ? '\n\n' + token + '\n\n' : token;
    };
    let t = text
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => stash(m, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => stash(m, true))
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => stash(m, false))
        .replace(/\$(?=\S)([^\n$]+?)(?<=\S)\$/g, (_, m) => stash(m, false));

    // 2. Markdown -> HTML, then sanitize
    let html = marked.parse(t, { breaks: true });
    html = DOMPurify.sanitize(html);

    // 3. Put the math back, rendered by KaTeX
    html = html.replace(/MATHTOKEN(\d+)ENDTOKEN/g, (_, i) => {
        const m = maths[Number(i)];
        try {
            return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false });
        } catch (e) {
            return escapeHtml(m.tex);
        }
    });
    return html;
}

function formatMessage(text, sender) {
    if (!text) return '';
    return sender === 'user' ? escapeHtml(text).replace(/\n/g, '<br>') : renderRichText(text);
}

function appendMessageToUI(text, sender, base64Image = null) {
    const msgId = 'msg_' + (++msgCounter);
    let imgHtml = '';
    
    if (base64Image) {
        imgHtml = `<img src="data:${pendingImageMimeType};base64,${base64Image}" style="max-width: 100%; border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--line);">`;
    }

    const formattedText = formatMessage(text, sender);

    const html = `<div id="${msgId}" class="chat-msg ${sender}">${imgHtml}${formattedText}</div>`;
    
    // Add to BOTH chat windows to keep them perfectly synced
    fullChatMessages.insertAdjacentHTML('beforeend', html);
    overlayChatMessages.insertAdjacentHTML('beforeend', html);
    
    // Auto-scroll to bottom
    fullChatMessages.scrollTop = fullChatMessages.scrollHeight;
    overlayChatMessages.scrollTop = overlayChatMessages.scrollHeight;

    return msgId;
}

function updateMessageInUI(msgId, newText) {
    if (!newText) newText = "Sorry, I received an empty response.";
    
    const formattedText = formatMessage(newText, 'ai');

    // Update BOTH chat windows
    const msgEls = document.querySelectorAll(`#${msgId}`);
    msgEls.forEach(el => {
        el.innerHTML = formattedText;
    });

    // Auto-scroll again
    fullChatMessages.scrollTop = fullChatMessages.scrollHeight;
    overlayChatMessages.scrollTop = overlayChatMessages.scrollHeight;
}

// ==========================================
// IMAGE PASTE HANDLING
// ==========================================

function handleImagePaste(e) {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    
    for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            
            reader.onload = function(event) {
                // Extract just the base64 data string
                const base64Data = event.target.result.split(',')[1]; 
                
                pendingImageBase64 = base64Data;
                pendingImageMimeType = item.type;
                
                // Update UI to let user know image is attached
                fullChatInput.placeholder = "📸 Image attached! Type a question & press Enter...";
                overlayChatInput.placeholder = "📸 Image attached! Press Enter...";
                
                // Keep the input focused so they can type immediately
                e.target.focus();
            };
            
            reader.readAsDataURL(blob);
            // Prevent the default paste behavior so the filename doesn't paste as text
            e.preventDefault(); 
            break; 
        }
    }
}

function resetInputPlaceholder() {
    fullChatInput.placeholder = "Type your doubt or paste an image (Ctrl+V)...";
    overlayChatInput.placeholder = "Ask a doubt...";
}
