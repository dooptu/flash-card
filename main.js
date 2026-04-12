/**
 * FlashMaster — main.js (v3 — Full Rewrite)
 *
 * Key design decisions:
 *  - Flip + Swipe handled entirely in pointerdown/pointermove/pointerup
 *    (NO separate click listener to avoid event conflicts)
 *  - Always explicitly set BOTH scenes [hidden] on every render
 *  - Starred uses a Set<string> per topic → O(1) lookup
 *  - Only 1 card element in the DOM at a time → O(1) draw cost
 */

class FlashMaster {
  constructor() {
    this.topics         = [];
    this.originalCards  = [];
    this.cards          = [];
    this.currentIndex   = 0;
    this.currentTopicId = null;
    this.studyMode      = localStorage.getItem('fm_mode') || 'flashcard';
    this.isShuffle      = false;
    this.showStarred    = false;
    this.isFlipped      = false;

    // Starred: { [topicId]: Set<cardId> }
    this._starred = {};
    this._loadStarred();

    this._init();
  }

  /* ─── Starred storage ─────────────────────────────── */
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

  /* ─── Bootstrap ───────────────────────────────────── */
  async _init() {
    this._dom();
    this._bindAll();
    await this._loadConfig();
    this._buildTopicList();
    this._syncModeUI();

    const lastId = localStorage.getItem('fm_topic');
    const topic  = this.topics.find(t => t.id === lastId) || this.topics[0];
    if (topic) this._selectTopic(topic.id);
  }

  /* ─── DOM references ──────────────────────────────── */
  _dom() {
    const g = id => document.getElementById(id);
    this.D = {
      sidebar:          g('sidebar'),
      overlay:          g('overlay'),
      menuToggle:       g('menuToggle'),
      closeSidebar:     g('closeSidebar'),
      topicList:        g('topicList'),
      topicTitle:       g('currentTopicName'),
      progressBar:      g('progressBar'),
      cardCounter:      g('cardCounter'),
      starBtn:          g('starBtn'),
      starredOnlyBtn:   g('starredOnlyBtn'),
      shuffleBtn:       g('shuffleBtn'),
      prevBtn:          g('prevBtn'),
      nextBtn:          g('nextBtn'),
      modePills:        document.querySelectorAll('.mode-pill'),
      // Flashcard scene
      cardScene:        g('cardScene'),
      cardWrap:         g('cardWrap'),
      frontText:        g('frontText'),
      backText:         g('backText'),
      tapHint:          g('tapHint'),
      // Quiz scene
      quizScene:        g('quizScene'),
      quizQuestionText: g('quizQuestionText'),
      quizOptionsGrid:  g('quizOptionsGrid'),
    };
  }

  /* ─── Event binding ───────────────────────────────── */
  _bindAll() {
    const { D } = this;

    // Sidebar
    D.menuToggle.addEventListener('click',   () => this._openSidebar());
    D.closeSidebar.addEventListener('click', () => this._closeSidebar());
    D.overlay.addEventListener('click',      () => this._closeSidebar());

    // Mode pills
    D.modePills.forEach(btn =>
      btn.addEventListener('click', () => this._setMode(btn.dataset.mode))
    );

    // Toolbar
    D.starredOnlyBtn.addEventListener('click', () => this._toggleStarFilter());
    D.shuffleBtn.addEventListener('click',     () => this._toggleShuffle());

    // Star button (outside 3D stack — always clickable)
    D.starBtn.addEventListener('click', () => this._toggleStarCurrent());

    // Navigation buttons
    D.prevBtn.addEventListener('click', () => this._go(-1));
    D.nextBtn.addEventListener('click', () => this._go(1));

    // Keyboard
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft')  this._go(-1);
      if (e.key === 'ArrowRight') this._go(1);
      if ((e.key === ' ' || e.key === 'Enter') && this.studyMode === 'flashcard') {
        e.preventDefault();
        this._flip();
      }
    });

    // Card wrap — click to flip only
    D.cardWrap.addEventListener('click', () => this._flip());
  }

  /* ─── Config & Topics ─────────────────────────────── */
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

    // Highlight active
    this.D.topicList.querySelectorAll('.topic-item')
      .forEach(el => el.classList.toggle('active', el.dataset.id === id));

    this._showLoading();

    try {
      const r = await fetch(topic.path);
      const d = await r.json();
      this.originalCards = Array.isArray(d.cards) ? d.cards : [];
      this._applyFilters();
      this.currentIndex = 0;
      this._render();
    } catch {
      this._showError();
    }
  }

  /* ─── Filters ─────────────────────────────────────── */
  _applyFilters() {
    // Show ALL cards regardless of type — mode controls display format only
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

  /* ─── Master render ───────────────────────────────── */
  _render() {
    const { D, cards } = this;

    if (cards.length === 0) {
      this._showEmpty();
      return;
    }

    const card    = cards[this.currentIndex];
    const total   = cards.length;
    const current = this.currentIndex + 1;
    const starred = this._isStarred(card.id);

    // HUD
    D.cardCounter.textContent     = `${current} / ${total}`;
    D.progressBar.style.width     = `${(current / total) * 100}%`;
    D.prevBtn.disabled            = this.currentIndex === 0;
    D.nextBtn.disabled            = this.currentIndex === total - 1;
    D.starBtn.classList.toggle('starred', starred);
    D.starBtn.title               = starred ? 'Bỏ đánh dấu' : 'Đánh dấu';

    if (this.studyMode === 'flashcard') {
      // ── Show ONLY card scene, hide quiz scene ──────
      D.cardScene.hidden = false;
      D.quizScene.hidden = true;

      // Reset flip state
      this.isFlipped = false;
      D.cardWrap.classList.remove('flipped');
      D.cardWrap.style.transform = '';
      D.cardWrap.style.opacity   = '';

      D.frontText.textContent = card.question;
      D.backText.textContent  = card.answer;
      D.tapHint.textContent   = 'Nhấn để lật';

    } else {
      // Quiz mode — if card has options show quiz, else fall back to flashcard view
      const hasOptions = Array.isArray(card.options) && card.options.length >= 2;

      if (hasOptions) {
        // ── Show ONLY quiz scene, hide card scene ────
        D.cardScene.hidden = true;
        D.quizScene.hidden = false;

        D.quizQuestionText.textContent = card.question;

        const grid = D.quizOptionsGrid;
        grid.innerHTML = '';

        card.options.forEach(opt => {
          const btn = document.createElement('button');
          btn.className   = 'quiz-opt-card';
          btn.textContent = opt;

          btn.addEventListener('click', () => {
            grid.querySelectorAll('.quiz-opt-card').forEach(b => {
              b.classList.add('answered');
              if (b.textContent === card.answer) b.classList.add('correct');
              else if (b === btn)               b.classList.add('wrong');
            });
          }, { once: true });

          grid.appendChild(btn);
        });

      } else {
        // No options — fall back to flashcard display
        D.cardScene.hidden = false;
        D.quizScene.hidden = true;
        this.isFlipped = false;
        D.cardWrap.classList.remove('flipped');
        D.cardWrap.style.transform = '';
        D.cardWrap.style.opacity   = '';
        D.frontText.textContent = card.question;
        D.backText.textContent  = card.answer;
        D.tapHint.textContent   = 'Nhấn để lật';
      }
    }
  }

  /* ─── State screens ───────────────────────────────── */
  _showLoading() {
    const { D } = this;
    D.cardScene.hidden = false;
    D.quizScene.hidden = true;
    D.cardWrap.classList.remove('flipped');
    D.frontText.textContent = 'Đang tải…';
    D.backText.textContent  = '';
    D.tapHint.textContent   = '';
    D.cardCounter.textContent = '—';
    D.progressBar.style.width = '0%';
    D.prevBtn.disabled = true;
    D.nextBtn.disabled = true;
  }

  _showEmpty() {
    const { D } = this;
    D.cardScene.hidden = false;
    D.quizScene.hidden = true;
    D.cardWrap.classList.remove('flipped');
    const modeLabel = this.studyMode === 'flashcard' ? 'thẻ ghi nhớ' : 'câu hỏi trắc nghiệm';
    D.frontText.textContent = this.showStarred
      ? 'Không có thẻ được đánh dấu ★'
      : `Chủ đề này chưa có ${modeLabel}`;
    D.backText.textContent  = '';
    D.tapHint.textContent   = '';
    D.cardCounter.textContent = '0 / 0';
    D.progressBar.style.width = '0%';
    D.prevBtn.disabled = true;
    D.nextBtn.disabled = true;
  }

  _showError() {
    const { D } = this;
    D.cardScene.hidden = false;
    D.quizScene.hidden = true;
    D.frontText.textContent = 'Không tải được dữ liệu :(';
    D.backText.textContent  = '';
    D.tapHint.textContent   = 'Kiểm tra lại file JSON';
  }

  /* ─── Navigation ──────────────────────────────────── */
  _go(dir) {
    const newIdx = this.currentIndex + dir;
    if (newIdx < 0 || newIdx >= this.cards.length) return;
    this.currentIndex = newIdx;
    this._render();
  }

  /* ─── Flip ─────────────────────────────────────────── */
  _flip() {
    if (this.cards.length === 0) return;
    this.isFlipped = !this.isFlipped;
    this.D.cardWrap.classList.toggle('flipped', this.isFlipped);
  }

  /* ─── Star ─────────────────────────────────────────── */
  _toggleStarCurrent() {
    if (this.cards.length === 0) return;
    const card = this.cards[this.currentIndex];
    const set  = this._starSet();

    if (set.has(card.id)) set.delete(card.id);
    else                   set.add(card.id);

    this._saveStarred();

    // Update only the star button (no full re-render needed)
    const isStr = set.has(card.id);
    this.D.starBtn.classList.toggle('starred', isStr);
    this.D.starBtn.title = isStr ? 'Bỏ đánh dấu' : 'Đánh dấu';
  }

  /* ─── Filters toggle ──────────────────────────────── */
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

  /* ─── Mode switch ─────────────────────────────────── */
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

  /* ─── Sidebar ─────────────────────────────────────── */
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
