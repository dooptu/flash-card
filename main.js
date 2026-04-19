/**
 * FlashMaster — main.js (v4 — AI-Powered)
 *
 * Key design decisions:
 *  - Flip + Swipe handled entirely in pointerdown/pointermove/pointerup
 *    (NO separate click listener to avoid event conflicts)
 *  - Always explicitly set BOTH scenes [hidden] on every render
 *  - Starred uses a Set<string> per topic  O(1) lookup
 *  - Only 1 card element in the DOM at a time  O(1) draw cost
 *  - AI Explain uses Gemini REST API with streaming (SSE)
 */

/* =======================================================
   GEMINI AI SERVICE
======================================================= */
class GeminiAI {
  constructor() {
    // Priority: config.js (FM_CONFIG) > localStorage (Settings modal) > default
    const cfg = window.FM_CONFIG || {};
    this.apiKey = cfg.GEMINI_API_KEY || localStorage.getItem('fm_gemini_key') || '';
    this.model = cfg.GEMINI_MODEL || localStorage.getItem('fm_gemini_model') || 'gemini-2.0-flash';
    this.language = cfg.GEMINI_LANG || localStorage.getItem('fm_gemini_lang') || 'vi';
  }
  _baseUrl() {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
  }

  _buildPrompt(question, answer) {
    const langInstruction = this.language === 'vi'
      ? 'Hay tra loi hoan toan bang Tieng Viet.'
      : 'Please answer entirely in English.';

    return `${langInstruction}

Ban la mot giang vien chuyen ve lap trinh web va phat trien phan mem.
Hay giai thich chi tiet va de hieu ve cau hoi va cau tra loi duoi day.

**Cau hoi:** ${question}

**Cau tra loi ngan:** ${answer} 

Hay cung cap:
1. **Giai thich co ban** — Tai sao cau tra loi do dung, khai niem cot loi la gi?
2. **Vi du minh hoa** — Dua ra vi du code hoac tinh huong thuc te neu phu hop
3. **Meo ghi nho** — Cach ghi nho hoac ap dung trong thuc te
4. **Mo rong** — Cac diem lien quan hoac luu y quan trong (neu co)

Trinh bay ro rang, co cau truc, dung markdown (heading ##, bullet -, code block \`\`\`).`;
  }

  /**
   * Stream giai thich tu Gemini API
   * @param {string} question
   * @param {string} answer
   * @param {function} onChunk  - callback nhan tung doan text
   * @param {AbortSignal} signal
   */
  async streamExplain(question, answer, onChunk, signal) {
    if (!this.apiKey) throw new Error('NO_API_KEY');

    const body = {
      contents: [{
        parts: [{ text: this._buildPrompt(question, answer) }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      }
    };

    const res = await fetch(this._baseUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      let msg = `Loi API ${res.status}`;
      let retryAfter = 0;
      try {
        const errJson = JSON.parse(errText);
        msg = errJson?.error?.message || msg;
      } catch { /* ignore */ }

      // Parse "Please retry in 28.06s" from Gemini rate-limit messages
      const retryMatch = msg.match(/retry in ([\d.]+)s/i);
      if (retryMatch) retryAfter = Math.ceil(parseFloat(retryMatch[1]));

      // 429 = quota / rate-limit, 403 = invalid key
      if (res.status === 429 || retryAfter > 0) {
        const err = new Error(msg);
        err.type = 'RATE_LIMIT';
        err.retryAfter = retryAfter || 60;
        throw err;
      }
      if (res.status === 403 || res.status === 401) {
        const err = new Error('API Key khong hop le hoac bi thu hoi.');
        err.type = 'INVALID_KEY';
        throw err;
      }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          const chunk = json?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (chunk) onChunk(chunk);
        } catch { /* skip malformed */ }
      }
    }
  }
}

/* =======================================================
   MARKDOWN PARSER (lightweight)
======================================================= */
function parseMarkdown(text) {
  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold + Italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // List items
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Ordered list items
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs
  html = html.replace(/^(?!<[hupblo])(.+)$/gm, line => {
    if (line.trim() === '') return '';
    return `<p>${line}</p>`;
  });

  return html;
}

/* =======================================================
   TOAST NOTIFICATION
======================================================= */
function showToast(msg, type = 'info', duration = 2200) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

/* =======================================================
   SETTINGS MODAL CONTROLLER
======================================================= */
class SettingsModal {
  constructor(ai) {
    this.ai = ai;
    this.D = {
      backdrop: document.getElementById('settingsModalBackdrop'),
      close: document.getElementById('settingsModalClose'),
      apiKey: document.getElementById('apiKeyInput'),
      toggle: document.getElementById('apiKeyToggle'),
      model: document.getElementById('geminiModelSelect'),
      language: document.getElementById('languageSelect'),
      saveBtn: document.getElementById('settingsSaveBtn'),
    };
    this._bind();
    this._load();
  }

  _load() {
    const { D, ai } = this;
    D.apiKey.value = ai.apiKey;
    D.model.value = ai.model;
    D.language.value = ai.language;
    if (ai.apiKey) D.apiKey.classList.add('valid');
  }

  _bind() {
    const { D } = this;

    document.getElementById('settingsBtn')?.addEventListener('click', () => this.open());
    D.close.addEventListener('click', () => this.close());
    D.backdrop.addEventListener('click', e => { if (e.target === D.backdrop) this.close(); });

    D.toggle.addEventListener('click', () => {
      const isHidden = D.apiKey.type === 'password';
      D.apiKey.type = isHidden ? 'text' : 'password';
      D.toggle.textContent = isHidden ? '\uD83D\uDE48' : '\uD83D\uDC41';
    });

    D.saveBtn.addEventListener('click', () => this._save());

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !D.backdrop.hidden) this.close();
    });
  }

  _save() {
    const key = this.D.apiKey.value.trim();
    const model = this.D.model.value;
    const lang = this.D.language.value;

    localStorage.setItem('fm_gemini_key', key);
    localStorage.setItem('fm_gemini_model', model);
    localStorage.setItem('fm_gemini_lang', lang);

    this.ai.apiKey = key;
    this.ai.model = model;
    this.ai.language = lang;

    this.D.apiKey.classList.toggle('valid', key.length > 10);
    showToast('\u2705 Da luu cai dat AI', 'ok');
    this.close();
  }

  open() { this._load(); this.D.backdrop.hidden = false; }
  close() { this.D.backdrop.hidden = true; }
}

/* =======================================================
   AI MODAL CONTROLLER
======================================================= */
class AIModal {
  constructor(ai) {
    this.ai = ai;
    this._abortCtrl = null;
    this._rawText = '';
    this._currentQ = null;
    this._currentA = null;

    this.D = {
      backdrop: document.getElementById('aiModalBackdrop'),
      close: document.getElementById('aiModalClose'),
      context: document.getElementById('aiModalContext'),
      loading: document.getElementById('aiLoading'),
      content: document.getElementById('aiContent'),
      error: document.getElementById('aiError'),
      errorMsg: document.getElementById('aiErrorMsg'),
      retryBtn: document.getElementById('aiRetryBtn'),
      copyBtn: document.getElementById('aiCopyBtn'),
    };

    this._bind();
  }

  _bind() {
    const { D } = this;
    D.close.addEventListener('click', () => this.close());
    D.backdrop.addEventListener('click', e => { if (e.target === D.backdrop) this.close(); });
    D.retryBtn.addEventListener('click', () => this._fetch());
    D.copyBtn.addEventListener('click', () => this._copy());

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !D.backdrop.hidden) this.close();
    });
  }

  open(question, answer) {
    this._currentQ = question;
    this._currentA = answer;
    this._rawText = '';

    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    this.D.context.innerHTML = `<strong>Cau hoi</strong>${esc(question)}`;

    this._showState('loading');
    this.D.backdrop.hidden = false;
    this._fetch();
  }

  close() {
    if (this._abortCtrl) { this._abortCtrl.abort(); this._abortCtrl = null; }
    this._clearCountdown();
    this.D.backdrop.hidden = true;
  }

  _showState(state) {
    this.D.loading.hidden = state !== 'loading';
    this.D.content.hidden = state !== 'content';
    this.D.error.hidden = state !== 'error';
  }

  async _fetch() {
    if (!this.ai.apiKey) {
      this._showError('Chua co API Key. Nhan bieu tuong \u2699 de cau hinh.');
      return;
    }

    // Clear any existing countdown
    this._clearCountdown();

    this._showState('loading');
    this._rawText = '';
    this.D.content.innerHTML = '';

    if (this._abortCtrl) this._abortCtrl.abort();
    this._abortCtrl = new AbortController();

    try {
      await this.ai.streamExplain(
        this._currentQ,
        this._currentA,
        chunk => this._handleChunk(chunk),
        this._abortCtrl.signal,
      );
      this.D.content.classList.remove('typing');
    } catch (err) {
      if (err.name === 'AbortError') return;

      if (err.message === 'NO_API_KEY') {
        this._showError('Chua co API Key. Nhan bieu tuong \u2699 de cau hinh.');
        return;
      }
      if (err.type === 'INVALID_KEY') {
        this._showError('\uD83D\uDD11 API Key khong hop le. Kiem tra lai trong \u2699 Settings.');
        return;
      }
      if (err.type === 'RATE_LIMIT') {
        this._showRateLimit(err.retryAfter, err.message);
        return;
      }
      this._showError(err.message || 'Da xay ra loi khi goi API.');
    }
  }

  _showRateLimit(seconds, rawMsg) {
    // Detect if it's a daily quota exhaustion (limit: 0) or just a per-minute limit
    const isDailyQuota = /limit:\s*0/i.test(rawMsg);
    this._showState('error');

    const headline = isDailyQuota
      ? '\uD83D\uDEAB Quota mien phi da het trong ngay'
      : '\u23F3 Qua nhieu yeu cau, can cho mot chut';

    const subline = isDailyQuota
      ? 'Free tier co gioi han. Quota se reset vao dau ngay mai (UTC). Ban co the dung API key khac hoac nang cap plan.'
      : 'Gemini free tier gioi han so request moi phut.';

    this.D.errorMsg.innerHTML =
      `<strong>${headline}</strong><br><small>${subline}</small>`;

    if (!isDailyQuota && seconds > 0) {
      // Auto-countdown and retry
      this._startCountdown(seconds);
    } else {
      // Daily quota — just show help links, no countdown
      this.D.retryBtn.textContent = 'Thu lai';
      this.D.retryBtn.disabled = false;
    }
  }

  _startCountdown(secs) {
    let remaining = secs;
    const btn = this.D.retryBtn;
    btn.disabled = true;
    btn.textContent = `Tu dong retry sau ${remaining}s...`;

    this._countdownTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        this._clearCountdown();
        btn.disabled = false;
        btn.textContent = 'Thu lai';
        // Auto-retry
        if (!this.D.backdrop.hidden) this._fetch();
      } else {
        btn.textContent = `Tu dong retry sau ${remaining}s...`;
      }
    }, 1000);
  }

  _clearCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    // Reset retry button
    if (this.D && this.D.retryBtn) {
      this.D.retryBtn.disabled = false;
      this.D.retryBtn.textContent = 'Thu lai';
    }
  }

  _handleChunk(chunk) {
    this._rawText += chunk;

    if (!this.D.loading.hidden) {
      this._showState('content');
      this.D.content.classList.add('typing');
    }

    this.D.content.innerHTML = parseMarkdown(this._rawText);
    this.D.content.classList.add('typing');

    const body = this.D.content.parentElement;
    body.scrollTop = body.scrollHeight;
  }

  _showError(msg) {
    this.D.errorMsg.innerHTML = msg; // allow basic HTML for formatted messages
    this.D.retryBtn.disabled = false;
    this.D.retryBtn.textContent = 'Thu lai';
    this._showState('error');
  }

  _copy() {
    if (!this._rawText) return;
    navigator.clipboard.writeText(this._rawText)
      .then(() => {
        this.D.copyBtn.textContent = '\u2705 Da sao chep';
        this.D.copyBtn.classList.add('copied');
        setTimeout(() => {
          this.D.copyBtn.textContent = '\uD83D\uDCCB Sao chep';
          this.D.copyBtn.classList.remove('copied');
        }, 2000);
      })
      .catch(() => showToast('Khong the sao chep', 'err'));
  }
}

/* =======================================================
   FLASHMASTER — Main Application
======================================================= */
class FlashMaster {
  constructor() {
    this.topics = [];
    this.originalCards = [];
    this.cards = [];
    this.currentIndex = 0;
    this.currentTopicId = null;
    this.studyMode = localStorage.getItem('fm_mode') || 'flashcard';
    this.isShuffle = false;
    this.showStarred = false;
    this.isFlipped = false;

    // Starred: { [topicId]: Set<cardId> }
    this._starred = {};
    this._loadStarred();

    // AI services
    this.gemini = new GeminiAI();
    this.aiModal = new AIModal(this.gemini);
    this.settingsModal = new SettingsModal(this.gemini);

    this._init();
  }

  /* --- Starred storage -------------------------------- */
  _loadStarred() {
    try {
      const raw = JSON.parse(localStorage.getItem('fm_starred') || '{}');
      for (const [k, v] of Object.entries(raw)) {
        this._starred[k] = new Set(Array.isArray(v) ? v : []);
      }
    } catch { /* ignore */ }
  }

  _saveStarred() {
    const raw = {};
    for (const [k, v] of Object.entries(this._starred)) raw[k] = [...v];
    localStorage.setItem('fm_starred', JSON.stringify(raw));
  }

  _starSet() {
    if (!this._starred[this.currentTopicId]) {
      this._starred[this.currentTopicId] = new Set();
    }
    return this._starred[this.currentTopicId];
  }

  _isStarred(cardId) {
    return this._starred[this.currentTopicId]?.has(cardId) ?? false;
  }

  /* --- Bootstrap --------------------------------------- */
  async _init() {
    this._dom();
    this._bindAll();
    await this._loadConfig();
    this._buildTopicList();
    this._syncModeUI();

    const lastId = localStorage.getItem('fm_topic');
    const topic = this.topics.find(t => t.id === lastId) || this.topics[0];
    if (topic) this._selectTopic(topic.id);
  }

  /* --- DOM references ---------------------------------- */
  _dom() {
    const g = id => document.getElementById(id);
    this.D = {
      sidebar: g('sidebar'),
      overlay: g('overlay'),
      menuToggle: g('menuToggle'),
      closeSidebar: g('closeSidebar'),
      topicList: g('topicList'),
      topicTitle: g('currentTopicName'),
      progressBar: g('progressBar'),
      cardCounter: g('cardCounter'),
      starBtn: g('starBtn'),
      starredOnlyBtn: g('starredOnlyBtn'),
      shuffleBtn: g('shuffleBtn'),
      fullscreenBtn: g('fullscreenBtn'),
      prevBtn: g('prevBtn'),
      nextBtn: g('nextBtn'),
      aiExplainBtn: g('aiExplainBtn'),
      modePills: document.querySelectorAll('.mode-pill'),
      // Flashcard scene
      cardScene: g('cardScene'),
      cardWrap: g('cardWrap'),
      frontText: g('frontText'),
      backText: g('backText'),
      tapHint: g('tapHint'),
      // Quiz scene
      quizScene: g('quizScene'),
      quizQuestionText: g('quizQuestionText'),
      quizOptionsGrid: g('quizOptionsGrid'),
      fsExitFab: g('fsExitFab'),
    };
  }

  /* --- Event binding ----------------------------------- */
  _bindAll() {
    const { D } = this;

    // Sidebar
    D.menuToggle.addEventListener('click', () => this._openSidebar());
    D.closeSidebar.addEventListener('click', () => this._closeSidebar());
    D.overlay.addEventListener('click', () => this._closeSidebar());

    // Mode pills
    D.modePills.forEach(btn =>
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode))
    );

    // Toolbar
    D.shuffleBtn.addEventListener('click', () => this._toggleShuffle());
    D.fullscreenBtn.addEventListener('click', () => this._toggleFullscreen());
    D.fsExitFab.addEventListener('click', () => this._toggleFullscreen());

    // Sync icon on exit (Esc key)
    document.addEventListener('fullscreenchange', () => this._syncFullscreenIcon());

    // Star button
    D.starBtn.addEventListener('click', () => this._toggleStarCurrent());

    // Navigation
    D.prevBtn.addEventListener('click', () => this._go(-1));
    D.nextBtn.addEventListener('click', () => this._go(1));

    // AI Explain
    D.aiExplainBtn.addEventListener('click', () => this._openAIExplain());

    // Keyboard
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') this._go(-1);
      if (e.key === 'ArrowRight') this._go(1);
      
      // Up/Down to flip (Targeted for focused fullscreen mode)
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (this.studyMode === 'flashcard') {
          e.preventDefault();
          this._flip();
        }
      }

      if ((e.key === ' ' || e.key === 'Enter') && this.studyMode === 'flashcard') {
        e.preventDefault();
        this._flip();
      }
    });

    // Card wrap — click to flip
    D.cardWrap.addEventListener('click', () => this._flip());
  }

  /* --- Fullscreen ------------------------------------- */
  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        showToast('Lỗi khi vào chế độ toàn màn hình', 'err');
      });
    } else {
      document.exitFullscreen();
    }
  }

  _syncFullscreenIcon() {
    const icon = this.D.fullscreenBtn.querySelector('.tool-icon');
    const isFS = !!document.fullscreenElement;
    
    document.body.classList.toggle('is-fullscreen', isFS);

    if (isFS) {
      icon.textContent = 'fullscreen_exit';
      this.D.fullscreenBtn.title = 'Thoát toàn màn hình';
    } else {
      icon.textContent = 'fullscreen';
      this.D.fullscreenBtn.title = 'Toàn màn hình';
    }
  }

  /* --- AI Explain ------------------------------------- */
  _openAIExplain() {
    if (this.cards.length === 0) return;
    const card = this.cards[this.currentIndex];
    this.aiModal.open(card.question, card.answer);
  }

  _showAIBtn(show) {
    this.D.aiExplainBtn.hidden = !show;
  }

  /* --- Config & Topics -------------------------------- */
  async _loadConfig() {
    try {
      const r = await fetch('data/config.json');
      const d = await r.json();
      this.topics = d.topics || [];
    } catch (e) {
      console.error('Config load failed:', e);
    }
  }

  _buildTopicList() {
    this.D.topicList.innerHTML = this.topics
      .map(t => `<div class="topic-item" data-id="${t.id}" tabindex="0">${t.name}</div>`)
      .join('');

    this.D.topicList.querySelectorAll('.topic-item').forEach(el => {
      const go = () => {
        this._selectTopic(el.dataset.id);
        if (window.innerWidth <= 900) this._closeSidebar();
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }

  async _selectTopic(id) {
    const topic = this.topics.find(t => t.id === id);
    if (!topic) return;

    this.currentTopicId = id;
    localStorage.setItem('fm_topic', id);
    this.D.topicTitle.textContent = topic.name;

    this.D.topicList.querySelectorAll('.topic-item')
      .forEach(el => el.classList.toggle('active', el.dataset.id === id));

    this._showLoading();

    try {
      const r = await fetch(topic.path);
      const d = await r.json();
      this.originalCards = Array.isArray(d.cards) ? d.cards : [];
      this._applyFilters();
      
      // Load progress
      const savedIdx = parseInt(localStorage.getItem(`fm_progress_${id}`));
      this.currentIndex = (savedIdx >= 0 && savedIdx < this.cards.length) ? savedIdx : 0;
      
      this._render();
    } catch {
      this._showError();
    }
  }

  /* --- Filters ---------------------------------------- */
  _applyFilters() {
    let list = [...this.originalCards];

    if (this.showStarred) {
      const set = this._starred[this.currentTopicId];
      list = set ? list.filter(c => set.has(c.id)) : [];
    }

    if (this.isShuffle) {
      list = [...list];
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }

    this.cards = list;
  }

  /* --- Master render ---------------------------------- */
  _render() {
    const { D, cards } = this;

    // Hide AI button by default on new render
    this._showAIBtn(false);

    if (cards.length === 0) {
      this._showEmpty();
      return;
    }

    const card = cards[this.currentIndex];
    const total = cards.length;
    const current = this.currentIndex + 1;
    const starred = this._isStarred(card.id);

    // HUD
    D.cardCounter.textContent = `${current} / ${total}`;
    D.progressBar.style.width = `${(current / total) * 100}%`;
    D.prevBtn.disabled = this.currentIndex === 0;
    D.nextBtn.disabled = this.currentIndex === total - 1;
    D.starBtn.classList.toggle('starred', starred);
    D.starBtn.title = starred ? 'Bo danh dau' : 'Danh dau';

    if (this.studyMode === 'flashcard') {
      D.cardScene.hidden = false;
      D.quizScene.hidden = true;

      this.isFlipped = false;
      D.cardWrap.classList.remove('flipped');
      D.cardWrap.style.transform = '';
      D.cardWrap.style.opacity = '';

      D.frontText.textContent = card.question;
      D.backText.textContent = card.answer;
      D.tapHint.textContent = 'Nhan de lat';

    } else {
      const hasOptions = Array.isArray(card.options) && card.options.length >= 2;

      if (hasOptions) {
        D.cardScene.hidden = true;
        D.quizScene.hidden = false;

        D.quizQuestionText.textContent = card.question;

        const grid = D.quizOptionsGrid;
        grid.innerHTML = '';

        card.options.forEach(opt => {
          const btn = document.createElement('button');
          btn.className = 'quiz-opt-card';
          btn.textContent = opt;

          btn.addEventListener('click', () => {
            grid.querySelectorAll('.quiz-opt-card').forEach(b => {
              b.classList.add('answered');
              if (b.textContent === card.answer) b.classList.add('correct');
              else if (b === btn) b.classList.add('wrong');
            });
            // Show AI explain button after answering
            this._showAIBtn(true);
          }, { once: true });

          grid.appendChild(btn);
        });

      } else {
        D.cardScene.hidden = false;
        D.quizScene.hidden = true;
        this.isFlipped = false;
        D.cardWrap.classList.remove('flipped');
        D.cardWrap.style.transform = '';
        D.cardWrap.style.opacity = '';
        D.frontText.textContent = card.question;
        D.backText.textContent = card.answer;
        D.tapHint.textContent = 'Nhan de lat';
      }
    }
  }

  /* --- State screens ---------------------------------- */
  _showLoading() {
    const { D } = this;
    this._showAIBtn(false);
    D.cardScene.hidden = false;
    D.quizScene.hidden = true;
    D.cardWrap.classList.remove('flipped');
    D.frontText.textContent = 'Dang tai...';
    D.backText.textContent = '';
    D.tapHint.textContent = '';
    D.cardCounter.textContent = '\u2014';
    D.progressBar.style.width = '0%';
    D.prevBtn.disabled = true;
    D.nextBtn.disabled = true;
  }

  _showEmpty() {
    const { D } = this;
    D.cardScene.hidden = false;
    D.quizScene.hidden = true;
    D.cardWrap.classList.remove('flipped');
    const modeLabel = this.studyMode === 'flashcard' ? 'the ghi nho' : 'cau hoi trac nghiem';
    D.frontText.textContent = this.showStarred
      ? 'Khong co the duoc danh dau \u2605'
      : `Chu de nay chua co ${modeLabel}`;
    D.backText.textContent = '';
    D.tapHint.textContent = '';
    D.cardCounter.textContent = '0 / 0';
    D.progressBar.style.width = '0%';
    D.prevBtn.disabled = true;
    D.nextBtn.disabled = true;
  }

  _showError() {
    const { D } = this;
    D.cardScene.hidden = false;
    D.quizScene.hidden = true;
    D.frontText.textContent = 'Khong tai duoc du lieu :(';
    D.backText.textContent = '';
    D.tapHint.textContent = 'Kiem tra lai file JSON';
  }

  /* --- Navigation ------------------------------------- */
  _go(dir) {
    const newIdx = this.currentIndex + dir;
    if (newIdx < 0 || newIdx >= this.cards.length) return;
    this.currentIndex = newIdx;
    this._saveProgress();
    this._render();
  }

  /* --- Progress tracking ------------------------------ */
  _saveProgress() {
    if (this.currentTopicId) {
      localStorage.setItem(`fm_progress_${this.currentTopicId}`, this.currentIndex);
    }
  }

  /* --- Flip ------------------------------------------- */
  _flip() {
    if (this.cards.length === 0) return;
    this.isFlipped = !this.isFlipped;
    this.D.cardWrap.classList.toggle('flipped', this.isFlipped);
    // Show AI button when flipped to answer side
    this._showAIBtn(this.isFlipped);
  }

  /* --- Star ------------------------------------------- */
  _toggleStarCurrent() {
    if (this.cards.length === 0) return;
    const card = this.cards[this.currentIndex];
    const set = this._starSet();

    if (set.has(card.id)) set.delete(card.id);
    else set.add(card.id);

    this._saveStarred();

    const isStr = set.has(card.id);
    this.D.starBtn.classList.toggle('starred', isStr);
    this.D.starBtn.title = isStr ? 'Bo danh dau' : 'Danh dau';
  }

  /* --- Filters toggle --------------------------------- */
  _toggleStarFilter() {
    this.showStarred = !this.showStarred;
    this.D.starredOnlyBtn.classList.toggle('active', this.showStarred);
    this._applyFilters();
    this.currentIndex = 0;
    this._render();
  }

  _toggleShuffle() {
    this.isShuffle = !this.isShuffle;
    this.D.shuffleBtn.classList.toggle('active', this.isShuffle);
    this._applyFilters();
    this.currentIndex = 0;
    this._render();
  }

  /* --- Mode switch ------------------------------------ */
  _setMode(mode) {
    if (mode === this.studyMode) return;
    this.studyMode = mode;
    localStorage.setItem('fm_mode', mode);
    this._syncModeUI();
    this._applyFilters();
    this.currentIndex = 0;
    this._render();
  }

  _syncModeUI() {
    this.D.modePills.forEach(btn =>
      btn.classList.toggle('active', btn.dataset.mode === this.studyMode)
    );
  }

  /* --- Sidebar ---------------------------------------- */
  _openSidebar() {
    this.D.sidebar.classList.add('open');
    this.D.overlay.classList.add('visible');
  }

  _closeSidebar() {
    this.D.sidebar.classList.remove('open');
    this.D.overlay.classList.remove('visible');
  }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new FlashMaster(); });
