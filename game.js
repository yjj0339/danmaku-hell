(() => {
  'use strict';
  const TAU = Math.PI * 2;
  let W = 640, H = 800, flightTop = 85, bossBaseY = 148;
  const $ = id => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d', { alpha: false });
  const palette = ['#ed926d', '#a281cd', '#df84a8', '#41a8bc', '#d8ac53'];
  const bosses = [
    { name: '棱镜', code: 'VECTOR', shape: 3, color: palette[0], hp: 1150, patterns: ['螺旋序曲', '环形回响', '三叶绽放'] },
    { name: '蜂巢', code: 'HEXA', shape: 6, color: palette[1], hp: 1500, patterns: ['六向折射', '交错光环', '六瓣花轮'] },
    { name: '星核', code: 'ORBIT', shape: 0, color: palette[2], hp: 1850, patterns: ['双生螺旋', '星环共振', '万花镜终章'] }
  ];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const format = n => String(Math.floor(n)).padStart(6, '0');
  const timeText = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const keys = new Set();
  let bullets = [], shots = [], particles = [], floaters = [], rings = [];
  let mode = 'title', boss = null, player = null, bossIndex = 0, defeated = 0;
  let score = 0, best = 0, bestAtStart = 0, grazes = 0, lives = 3, bombs = 3;
  let clock = 0, elapsed = 0, intro = 0, transition = 0, shotTimer = 0;
  let shake = 0, flash = 0, bombWave = 0, slowFlash = 0, hudDirty = true;
  let soundEnabled = true, reducedFX = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let db = null, savePending = 0, savePromise = Promise.resolve(), persistence = 'loading';
  let frameId = 0, lastTime = performance.now(), accumulator = 0, bannerUntil = 0;
  let pointer = null, lastTap = null, hitSoundAt = -1, grazeSoundAt = -1;
  let viewportFrame = 0, focusLayout = false, renderDpr = 1;
  const primaryPointer = matchMedia('(pointer: coarse)');
  let touchDevice = primaryPointer.matches;
  try { focusLayout = localStorage.getItem('danmaku-focus-layout') === 'true'; } catch {}

  function fitDisplay() {
    viewportFrame = 0;
    touchDevice = primaryPointer.matches;
    const viewport = window.visualViewport;
    const height = viewport && viewport.scale === 1 ? viewport.height : innerHeight;
    const compact = focusLayout || innerWidth < 780 || (touchDevice && innerWidth < 1180) || height < 560;
    document.body.classList.toggle('compact-layout', compact);
    document.body.classList.toggle('focus-layout', focusLayout);
    document.body.classList.toggle('medium-layout', !compact && innerWidth < 1100);
    document.body.classList.toggle('landscape-layout', innerWidth > height && height < 600);
    document.body.classList.toggle('touch-device', touchDevice);
    $('touch-instruction').textContent = touchDevice ? '在此拖动飞行' : 'WASD / 方向键移动';
    $('touch-pad').querySelector('small').textContent = touchDevice ? '手指不遮挡飞船 · 双击炸弹' : 'SHIFT 精密闪避 · 空格炸弹';
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    document.documentElement.style.setProperty('--content-height', `${document.querySelector('.layout').clientHeight}px`);
    $('layout-button').setAttribute('aria-pressed', String(focusLayout));
    $('layout-button').title = focusLayout ? '恢复自动布局' : '专注竖屏布局';
    const width = canvas.clientWidth, canvasHeight = canvas.clientHeight;
    if (!width || !canvasHeight) return;
    const ratio = canvasHeight / width;
    const nextW = ratio >= 1.25 ? 640 : 800 / ratio;
    const nextH = ratio >= 1.25 ? 640 * ratio : 800;
    const sx = nextW / W, sy = nextH / H;
    if (Math.abs(nextW - W) > .5 || Math.abs(nextH - H) > .5) {
      for (const entity of [...bullets, ...shots, ...particles, ...floaters, ...rings]) {
        entity.x *= sx; entity.y *= sy;
        if ('px' in entity) { entity.px *= sx; entity.py *= sy; }
        if ('previousY' in entity) entity.previousY *= sy;
        if ('vx' in entity) { entity.vx *= sx; entity.vy *= sy; }
      }
      if (player) { player.x *= sx; player.y *= sy; }
      if (boss) boss.x *= sx;
      W = nextW; H = nextH; pointer = null; lastTap = null;
      $('touch-pad').classList.remove('active');
      for (const shot of shots) shot.life = Math.max(shot.life, (H + 100) / 860);
    }
    const scale = width / W;
    // Reserve the visible health HUD, rather than a fixed number of logical pixels.
    const hudBottom = Math.max(70, $('boss-hud').offsetHeight + (compact ? 12 : 16) + 8);
    flightTop = Math.max(85, hudBottom / scale + 12);
    bossBaseY = Math.max(148, hudBottom / scale + 86);
    if (player) { player.x = clamp(player.x, 18, W - 18); player.y = clamp(player.y, flightTop, H - 28); }
    if (boss) boss.y = bossBaseY + Math.sin(boss.t * .72) * 21;
    // Limit backing pixels on high-DPI devices, while preserving crisp, uniform geometry.
    renderDpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(2200000 / (width * canvasHeight)));
    const rw = Math.round(width * renderDpr), rh = Math.round(canvasHeight * renderDpr);
    if (canvas.width !== rw || canvas.height !== rh) { canvas.width = rw; canvas.height = rh; }
    hudDirty = true;
  }
  function scheduleDisplay() { if (!viewportFrame) viewportFrame = requestAnimationFrame(fitDisplay); }

  // Best scores use an atomic read/compare/write transaction so another tab cannot lower the record.
  const storageReady = new Promise(resolve => {
    try {
      const request = indexedDB.open('danmaku-hell', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
      request.onsuccess = () => {
        db = request.result;
        db.onversionchange = () => { db.close(); db = null; };
        const tx = db.transaction('records', 'readonly');
        const get = tx.objectStore('records').get('best');
        get.onsuccess = () => { best = Math.max(best, Number(get.result?.score) || 0); hudDirty = true; };
        tx.oncomplete = () => { persistence = 'indexeddb'; updateStorageLabel(); resolve(); if (savePending) persistScore(savePending); };
        tx.onerror = () => storageFallback(resolve);
      };
      request.onerror = () => storageFallback(resolve);
      request.onblocked = () => { $('storage-status').textContent = '请关闭旧游戏标签页以启用存档'; };
    } catch { storageFallback(resolve); }
  });
  function storageFallback(resolve) {
    persistence = 'localstorage';
    try { best = Math.max(best, Number(localStorage.getItem('danmaku-best')) || 0); } catch { persistence = 'unavailable'; }
    hudDirty = true; updateStorageLabel(); resolve();
  }
  function updateStorageLabel() {
    $('storage-status').textContent = persistence === 'indexeddb' ? '本浏览器自动保存 · IndexedDB' : persistence === 'localstorage' ? '本浏览器自动保存 · 备用存储' : '当前浏览器无法保存纪录';
  }
  function persistScore(value) {
    savePending = Math.max(savePending, value);
    if (persistence === 'loading') return savePromise;
    if (!db) {
      if (persistence === 'localstorage') try {
        const stored = Number(localStorage.getItem('danmaku-best')) || 0;
        localStorage.setItem('danmaku-best', String(Math.max(stored, value))); savePending = 0;
      } catch { persistence = 'unavailable'; updateStorageLabel(); }
      return savePromise;
    }
    savePromise = new Promise(resolve => {
      try {
        const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
        const get = store.get('best');
        get.onsuccess = () => {
          const high = Math.max(Number(get.result?.score) || 0, value);
          store.put({ id: 'best', score: high, updated: Date.now() });
          best = Math.max(best, high); hudDirty = true;
        };
        tx.oncomplete = () => { if (savePending <= value) savePending = 0; resolve(); };
        tx.onerror = () => { persistence = 'unavailable'; updateStorageLabel(); resolve(); };
      } catch { persistence = 'unavailable'; updateStorageLabel(); resolve(); }
    });
    return savePromise;
  }

  class Sound {
    constructor() { this.context = null; this.master = null; this.noiseBuffer = null; }
    unlock() {
      if (!soundEnabled) return;
      try {
        if (!this.context) {
          const Audio = window.AudioContext || window.webkitAudioContext;
          if (!Audio) return;
          this.context = new Audio(); this.master = this.context.createGain();
          this.master.gain.value = .30; this.master.connect(this.context.destination);
          this.noiseBuffer = this.context.createBuffer(1, this.context.sampleRate * 1.1, this.context.sampleRate);
          const data = this.noiseBuffer.getChannelData(0);
          for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        }
        if (this.context.state === 'suspended') this.context.resume().catch(() => {});
      } catch { /* Gameplay remains available when an audio device is absent. */ }
    }
    tone(freq, endFreq, duration, gain, type = 'sine', delay = 0) {
      if (!soundEnabled || !this.context || this.context.state !== 'running') return;
      const t = this.context.currentTime + delay, o = this.context.createOscillator(), g = this.context.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), t + duration);
      g.gain.setValueAtTime(.001, t); g.gain.linearRampToValueAtTime(gain, t + .006); g.gain.exponentialRampToValueAtTime(.001, t + duration);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + duration + .02);
      o.onended = () => { o.disconnect(); g.disconnect(); };
    }
    noise(duration, gain) {
      if (!soundEnabled || !this.context || this.context.state !== 'running') return;
      const t = this.context.currentTime, s = this.context.createBufferSource(), g = this.context.createGain(), f = this.context.createBiquadFilter();
      s.buffer = this.noiseBuffer; f.type = 'lowpass'; f.frequency.setValueAtTime(2600, t); f.frequency.exponentialRampToValueAtTime(90, t + duration);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(.001, t + duration);
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + duration);
      s.onended = () => { s.disconnect(); f.disconnect(); g.disconnect(); };
    }
    play(name) {
      if (name === 'shoot') this.tone(880, 540, .07, .055, 'triangle');
      if (name === 'hit') this.tone(180, 80, .045, .10, 'triangle');
      if (name === 'graze') this.tone(1600, 2300, .075, .10);
      if (name === 'hurt') { this.noise(.38, .35); this.tone(240, 45, .42, .35, 'sawtooth'); }
      if (name === 'bomb') { this.noise(.85, .60); this.tone(125, 35, .8, .65); this.tone(650, 180, .6, .16, 'triangle'); }
      if (name === 'explode') { this.noise(1, .65); this.tone(180, 35, .8, .55); }
      if (name === 'phase') { [0, 1, 2].forEach(i => this.tone(330 + i * 110, 330 + i * 110, .17, .12, 'sine', i * .10)); }
      if (name === 'start') { [392, 523, 659, 784].forEach((f, i) => this.tone(f, f, .22, .13, 'triangle', i * .085)); }
      if (name === 'win') { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, f, .36, .19, 'triangle', i * .15)); }
      if (name === 'lose') { [330, 294, 220, 165].forEach((f, i) => this.tone(f, f, .35, .16, 'triangle', i * .18)); }
    }
  }
  const audio = new Sound();

  function updateHUD() {
    $('score').textContent = format(score); $('best-score').textContent = format(best);
    $('graze-count').textContent = String(grazes).padStart(3, '0');
    $('lives').innerHTML = Array.from({ length: 3 }, (_, i) => `<span class="${i >= lives ? 'spent' : ''}">▲</span>`).join(' ');
    $('bombs').innerHTML = Array.from({ length: 3 }, (_, i) => `<span class="${i >= bombs ? 'spent' : ''}">✺</span>`).join(' ') + (bombs > 3 ? `<small class="reserve-count">+${bombs - 3}</small>` : '');
    $('mobile-score').textContent = format(score); $('mobile-best').textContent = format(best); $('mobile-lives').textContent = '▲'.repeat(lives) + '△'.repeat(3 - lives);
    $('mobile-bombs').textContent = `✺ ${bombs}`;
    $('touch-bomb').disabled = bombs === 0 || mode !== 'playing';
    $('touch-bomb').setAttribute('aria-label', `释放炸弹，剩余 ${bombs} 颗`);
    $('run-counter').textContent = `BOSS ${String(Math.min(3, bossIndex + 1)).padStart(2, '0')} / 03`;
    document.querySelectorAll('.boss-card').forEach((card, i) => {
      card.classList.toggle('active', i === bossIndex && defeated < 3);
      card.classList.toggle('defeated', i < defeated);
      card.querySelector('.boss-card-status').textContent = i < defeated ? '✓' : String(i + 1).padStart(2, '0');
    });
    if (boss) {
      $('boss-name').textContent = `${String(bossIndex + 1).padStart(2, '0')} / ${boss.config.name}`;
      $('phase-name').textContent = `PHASE 0${boss.phase + 1} / 03`;
      $('pattern-name').textContent = boss.config.patterns[boss.phase];
      $('health-fill').style.width = `${Math.max(0, boss.hp / boss.config.hp * 100)}%`;
      $('health-fill').style.background = boss.config.color;
    }
    hudDirty = false;
  }
  function addScore(n) { score += n; best = Math.max(best, score); hudDirty = true; }
  function screens(id) {
    for (const name of ['start-screen', 'pause-screen', 'end-screen']) $(name).classList.toggle('hidden', name !== id);
    $('overlay').classList.toggle('hidden', !id);
  }
  function setGameplayUI(visible) {
    ['boss-hud', 'pause-button', 'touch-bomb'].forEach(id => $(id).classList.toggle('hidden', !visible));
  }
  function banner(kicker, title, copy, duration) {
    $('banner-kicker').textContent = kicker; $('banner-title').textContent = title; $('banner-copy').textContent = copy;
    $('battle-banner').classList.remove('hidden'); bannerUntil = clock + duration;
  }
  function newBoss(index) {
    const config = bosses[index]; bossIndex = index;
    boss = { config, hp: config.hp, x: W / 2, y: bossBaseY, t: 0, phase: 0, fire: 0, secondary: 0, cycle: 0, hurt: 0, shield: 0 };
    bullets = []; shots = []; intro = 2.0; transition = 0;
    player.invulnerable = Math.max(player.invulnerable, intro + .5);
    $('boss-hud').classList.remove('hidden');
    banner(`BOSS 0${index + 1} / ${config.code}`, config.name, config.patterns[0], 1.85);
    audio.play('phase'); hudDirty = true;
  }
  function start() {
    fitDisplay();
    audio.unlock(); audio.play('start'); keys.clear(); pointer = null; lastTap = null;
    bullets = []; shots = []; particles = []; floaters = []; rings = [];
    score = 0; bestAtStart = best; grazes = 0; lives = 3; bombs = 3; defeated = 0; elapsed = 0;
    shake = flash = bombWave = slowFlash = 0; shotTimer = 0; mode = 'playing';
    player = { x: W / 2, y: H - 140, radius: 2, invulnerable: 2.6, tilt: 0, focus: false };
    screens(null); setGameplayUI(true); $('arena-status').textContent = 'LIVE / STAY IN THE FLOW';
    newBoss(0); hudDirty = true; canvas.focus({ preventScroll: true }); scheduleDisplay();
  }
  function pause() {
    if (mode !== 'playing') return;
    mode = 'paused'; keys.clear(); pointer = null; hudDirty = true; $('touch-pad').classList.remove('active'); screens('pause-screen');
    $('arena-status').textContent = 'PAUSED / TAKE A BREATH'; $('resume-button').focus({ preventScroll: true });
  }
  function resume() {
    if (mode !== 'paused') return;
    mode = 'playing'; keys.clear(); pointer = null; hudDirty = true; screens(null); lastTime = performance.now(); accumulator = 0;
    $('arena-status').textContent = 'LIVE / STAY IN THE FLOW'; audio.unlock();
  }
  function finish(won) {
    if (mode !== 'playing') return;
    mode = won ? 'victory' : 'gameover'; pointer = null; keys.clear();
    persistScore(score); screens('end-screen'); setGameplayUI(false); $('battle-banner').classList.add('hidden');
    $('end-kicker').textContent = won ? 'ALL SYSTEMS CLEAR' : 'SIGNAL LOST';
    $('end-title').textContent = won ? '穿越了，地狱。' : '再试一次。';
    $('end-copy').textContent = won ? '三场决战结束。这片光雨，为你而绽放。' : '每一次失败，都让下一次闪避更从容。';
    $('end-score').textContent = format(score); $('end-bosses').textContent = `${defeated} / 3`;
    $('end-grazes').textContent = grazes; $('end-time').textContent = timeText(elapsed);
    $('record-tag').classList.toggle('hidden', score <= bestAtStart);
    $('arena-status').textContent = won ? 'COMPLETE / BEAUTIFULLY DONE' : 'GAME OVER / TRY AGAIN';
    audio.play(won ? 'win' : 'lose'); $('retry-button').focus({ preventScroll: true });
    if (won) { for (let i = 0; i < 7; i++) burst(80 + Math.random() * 480, 140 + Math.random() * 520, palette[i % 5], 30, 230); }
  }
  function home() {
    mode = 'title'; boss = null; player = null; bullets = []; shots = []; particles = []; rings = []; floaters = [];
    keys.clear(); pointer = null; bombWave = flash = shake = 0;
    $('battle-banner').classList.add('hidden'); screens('start-screen'); setGameplayUI(false);
    $('arena-status').textContent = 'READY TO PLAY'; $('start-button').focus({ preventScroll: true });
  }
  function burst(x, y, color, count = 16, speed = 100) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU, velocity = speed * (.25 + Math.random());
      particles.push({ x, y, vx: Math.cos(angle) * velocity, vy: Math.sin(angle) * velocity, life: .4 + Math.random() * .65, maxLife: 1.05, color, size: 1 + Math.random() * 3 });
    }
    if (particles.length > 650) particles.splice(0, particles.length - 650);
  }
  function popText(text, x, y, color = '#0aaaae') { floaters.push({ text, x, y, life: 1.2, color }); }
  function damagePlayer() {
    if (mode !== 'playing' || player.invulnerable > 0) return;
    lives--; hudDirty = true; audio.play('hurt');
    burst(player.x, player.y, '#12b7ba', 42, 210); rings.push({ x: player.x, y: player.y, r: 8, speed: 330, life: .55, color: '#18b4b6' });
    shake = .65; flash = .15;
    if (lives <= 0) { finish(false); return; }
    // A local safety bubble and 2.5 seconds of grace prevent a single pattern from taking several lives.
    bullets = bullets.filter(b => Math.hypot(b.x - player.x, b.y - player.y) > 105);
    player.invulnerable = 2.5; popText('核心受损', player.x, player.y - 30, '#cf6b73');
  }
  function useBomb() {
    if (mode !== 'playing' || bombs <= 0) return false;
    bombs--; hudDirty = true; audio.unlock(); audio.play('bomb');
    const cleared = bullets.length; addScore(cleared * 10);
    for (let i = 0; i < bullets.length; i += Math.max(1, Math.floor(bullets.length / 65))) burst(bullets[i].x, bullets[i].y, bullets[i].color, 3, 60);
    bullets = []; bombWave = 1.0; flash = .25; shake = .6; player.invulnerable = Math.max(player.invulnerable, 1.8);
    rings.push({ x: player.x, y: player.y, r: 0, speed: 1050, life: 1, color: '#0db8bd' });
    popText(`清屏 +${cleared * 10}`, player.x, player.y - 45);
    if (boss && intro <= 0 && transition <= 0) damageBoss(145);
    return true;
  }
  function damageBoss(amount) {
    if (!boss || intro > 0 || transition > 0 || boss.shield > 0) return;
    amount = Math.min(amount, boss.hp);
    boss.hp = Math.max(0, boss.hp - amount); boss.hurt = .055; hudDirty = true;
    addScore(amount * 2);
    if (boss.hp <= 0) { defeatBoss(); return; }
    const ratio = boss.hp / boss.config.hp;
    const nextPhase = ratio < .33 ? 2 : ratio < .66 ? 1 : 0;
    if (nextPhase !== boss.phase) {
      boss.phase = nextPhase; boss.fire = boss.secondary = boss.cycle = 0; boss.shield = .95;
      // New phases start clean, with a brief announcement rather than an instant overlapping barrage.
      for (let i = 0; i < bullets.length; i += 7) burst(bullets[i].x, bullets[i].y, bullets[i].color, 2, 30);
      bullets = []; rings.push({ x: boss.x, y: boss.y, r: 55, speed: 220, life: .8, color: boss.config.color });
      banner(`PHASE 0${nextPhase + 1} / 03`, boss.config.patterns[nextPhase], nextPhase === 2 ? '最终阶段 · 保持专注' : '攻击模式切换', .85);
      audio.play('phase');
    }
  }
  function defeatBoss() {
    const dead = boss; defeated++; bombs++; addScore(6000 + lives * 1000);
    bullets = []; shots = []; intro = 0; transition = 3.2; boss = null;
    burst(dead.x, dead.y, dead.config.color, 100, 290); burst(dead.x, dead.y, '#4ec3c6', 40, 190);
    rings.push({ x: dead.x, y: dead.y, r: 30, speed: 380, life: 1.2, color: dead.config.color });
    flash = .3; shake = .85; audio.play('explode'); player.invulnerable = 4;
    banner(`BOSS 0${bossIndex + 1} / CLEAR`, `${dead.config.name} · 击破`, '炸弹补充 +1', 2.6);
    $('boss-hud').classList.add('hidden'); hudDirty = true; persistScore(score);
  }
  function spawn(x, y, angle, speed, color, radius = 5, turn = 0, shape = 'orb') {
    bullets.push({ x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, radius, color, turn, shape, grazed: false, age: 0 });
  }
  function ring(count, angle, speed, color, options = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + TAU * i / count;
      spawn(boss.x + Math.cos(a) * 18, boss.y + Math.sin(a) * 18, a, typeof speed === 'function' ? speed(a) : speed, color, options.radius || 5, options.turn || 0, options.shape || 'orb');
    }
  }
  function aimed(count, spacing, speed, color) {
    const a = Math.atan2(player.y - boss.y, player.x - boss.x);
    for (let i = 0; i < count; i++) spawn(boss.x, boss.y, a + (i - (count - 1) / 2) * spacing, speed, color, 5, 0, 'diamond');
  }
  function firePattern(dt) {
    const p = boss.phase, t = boss.t, c = boss.config.color;
    boss.fire -= dt; boss.secondary -= dt;
    if (bossIndex === 0) {
      if (p === 0 && boss.fire <= 0) { ring(3, t * 1.9, 145, c, { radius: 5 }); boss.fire += .10; }
      if (p === 1 && boss.fire <= 0) { ring(28, boss.cycle * .19, 128, boss.cycle % 2 ? palette[2] : c); boss.fire += .76; boss.cycle++; }
      if (p === 2 && boss.fire <= 0) { ring(36, t * .15, a => 130 + 62 * Math.pow(Math.sin(a * 3 + t * .7), 2), c, { turn: .07 }); boss.fire += .92; }
      if (boss.secondary <= 0) { aimed(p === 0 ? 3 : 5, .16, 180 + p * 15, palette[1]); boss.secondary += p === 2 ? 1.1 : 1.65; }
    } else if (bossIndex === 1) {
      if (p === 0 && boss.fire <= 0) {
        for (let i = 0; i < 6; i++) for (let j = -1; j <= 1; j++) spawn(boss.x, boss.y, i * TAU / 6 + Math.sin(t * .8) * .5 + j * .10, 138 + Math.abs(j) * 22, c, 5, 0, 'diamond');
        boss.fire += .39;
      }
      if (p === 1 && boss.fire <= 0) {
        ring(30, boss.cycle % 2 ? .105 : 0, 130, boss.cycle % 2 ? palette[3] : c, { turn: boss.cycle % 2 ? -.10 : .10 });
        boss.fire += .64; boss.cycle++;
      }
      if (p === 2 && boss.fire <= 0) { ring(42, t * .12, a => 115 + 82 * Math.pow(Math.sin(a * 3 + t * .3), 2), c, { radius: 5 }); boss.fire += .88; }
      if (boss.secondary <= 0) { aimed(p === 2 ? 7 : 3, .14, 210, palette[0]); boss.secondary += p === 2 ? 1.2 : 1.8; }
    } else {
      if (p === 0 && boss.fire <= 0) {
        ring(2, t * 2, 155, palette[2], { turn: .10 }); ring(2, -t * 2 + Math.PI / 2, 155, palette[1], { turn: -.10 }); boss.fire += .11;
      }
      if (p === 1 && boss.fire <= 0) {
        ring(36, boss.cycle * .135, 135, palette[2]); ring(18, -boss.cycle * .22, 190, palette[3], { radius: 4 }); boss.fire += .91; boss.cycle++;
      }
      if (p === 2 && boss.fire <= 0) {
        ring(56, t * .19, a => 122 + 92 * Math.pow(Math.cos(a * 3.5 + t * .5), 2), boss.cycle % 2 ? palette[1] : palette[2], { turn: boss.cycle % 2 ? -.10 : .10 });
        boss.fire += .97; boss.cycle++;
      }
      if (boss.secondary <= 0) { aimed(p === 2 ? 9 : 5, .12, 210, palette[4]); boss.secondary += p === 2 ? 1.05 : 1.7; }
    }
    // Bounded in case a browser resumes after throttling; off-screen bullets also expire.
    if (bullets.length > 1500) bullets.splice(0, bullets.length - 1500);
  }

  function update(dt) {
    clock += dt;
    if (mode !== 'paused') updateEffects(dt);
    if (bannerUntil && clock >= bannerUntil && mode !== 'paused') { $('battle-banner').classList.add('hidden'); bannerUntil = 0; }
    if (mode !== 'playing') return;
    elapsed += dt; player.invulnerable = Math.max(0, player.invulnerable - dt);
    player.focus = keys.has('ShiftLeft') || keys.has('ShiftRight');
    let dx = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    let dy = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0);
    const norm = Math.hypot(dx, dy); if (norm) { dx /= norm; dy /= norm; }
    const speed = player.focus ? 140 : 310;
    if (pointer && !norm) {
      const mx = pointer.targetX - player.x, my = pointer.targetY - player.y, distance = Math.hypot(mx, my);
      const step = Math.min(distance, Math.max(1800, H * 2) * dt);
      if (distance > .1) { player.x += mx / distance * step; player.y += my / distance * step; dx = clamp(mx / 40, -1, 1); }
    } else { player.x += dx * speed * dt; player.y += dy * speed * dt; }
    player.x = clamp(player.x, 18, W - 18); player.y = clamp(player.y, flightTop, H - 28);
    player.tilt += (dx * .23 - player.tilt) * Math.min(1, dt * 12);
    if (transition > 0) {
      transition -= dt;
      if (transition <= 0) { if (defeated === 3) { addScore(lives * 3000 + bombs * 500); finish(true); } else newBoss(bossIndex + 1); }
      return;
    }
    if (intro > 0) { intro -= dt; return; }
    if (boss) {
      boss.t += dt; boss.hurt = Math.max(0, boss.hurt - dt); boss.shield = Math.max(0, boss.shield - dt);
      const range = (bossIndex === 0 ? 105 : bossIndex === 1 ? 135 : 155) * W / 640;
      boss.x = W / 2 + Math.sin(boss.t * (.45 + bossIndex * .06)) * range;
      boss.y = bossBaseY + Math.sin(boss.t * .72) * 21;
      if (boss.shield <= 0 && bombWave <= 0) firePattern(dt);
      shotTimer -= dt;
      if (shotTimer <= 0) {
        for (const offset of [-9, 9]) shots.push({ x: player.x + offset, y: player.y - 18, previousY: player.y - 18, life: (H + 100) / 860 });
        shotTimer += .085; audio.play('shoot');
      }
    }
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i]; s.previousY = s.y; s.y -= 860 * dt; s.life -= dt;
      if (boss && boss.shield <= 0 && Math.abs(s.x - boss.x) < 42 && s.y < boss.y + 42 && s.previousY > boss.y - 42) {
        shots.splice(i, 1); const bx = s.x, by = boss.y + 34;
        damageBoss(6); burst(bx, by, '#45bfc3', 2, 55);
        if (elapsed - hitSoundAt > .09) { audio.play('hit'); hitSoundAt = elapsed; }
        // defeatBoss clears the array; the loop index is reset to avoid reading an empty slot.
        if (!boss) break;
      } else if (s.y < -25 || s.life <= 0) shots.splice(i, 1);
    }
    if (!boss) return;
    if (player.invulnerable <= 0 && Math.hypot(player.x - boss.x, player.y - boss.y) < 39) damagePlayer();
    if (mode !== 'playing') return;
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i]; b.px = b.x; b.py = b.y; b.age += dt;
      if (b.turn) { const a = b.turn * dt, cos = Math.cos(a), sin = Math.sin(a), vx = b.vx; b.vx = vx * cos - b.vy * sin; b.vy = vx * sin + b.vy * cos; }
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -50 || b.x > W + 50 || b.y < -70 || b.y > H + 50 || b.age > Math.max(12, H / 100 + 4)) { bullets.splice(i, 1); continue; }
      // Swept distance prevents tunnelling even when a projectile crosses the tiny core in one step.
      const lx = b.x - b.px, ly = b.y - b.py, l2 = lx * lx + ly * ly;
      const u = l2 ? clamp(((player.x - b.px) * lx + (player.y - b.py) * ly) / l2, 0, 1) : 0;
      const distance = Math.hypot(player.x - b.px - lx * u, player.y - b.py - ly * u);
      if (player.invulnerable <= 0 && distance < b.radius + player.radius) {
        bullets.splice(i, 1); damagePlayer();
        // The damage safety bubble replaces the array, so do not continue with stale indices.
        break;
      }
      if (player.invulnerable <= 0 && !b.grazed && distance < b.radius + 23 && distance >= b.radius + player.radius) {
        b.grazed = true; grazes++; addScore(50); burst(player.x, player.y, '#10b6ba', 4, 75);
        if (elapsed - grazeSoundAt > .09) { audio.play('graze'); grazeSoundAt = elapsed; }
        if (grazes % 4 === 1) popText('+50', player.x + 25, player.y - 15);
      }
    }
    if (savePending && elapsed % 5 < dt) persistScore(score);
    else if (score > bestAtStart && elapsed % 8 < dt) persistScore(score);
  }
  function updateEffects(dt) {
    shake = Math.max(0, shake - dt * 1.5); flash = Math.max(0, flash - dt); bombWave = Math.max(0, bombWave - dt);
    for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 1.4; p.vy *= 1 - dt * 1.4; if (p.life <= 0) particles.splice(i, 1); }
    for (let i = rings.length - 1; i >= 0; i--) { rings[i].r += rings[i].speed * dt; rings[i].life -= dt; if (rings[i].life <= 0) rings.splice(i, 1); }
    for (let i = floaters.length - 1; i >= 0; i--) { floaters[i].life -= dt; floaters[i].y -= 25 * dt; if (floaters[i].life <= 0) floaters.splice(i, 1); }
  }

  const sprites = new Map();
  function bulletSprite(color, radius, shape) {
    const key = `${color}/${radius}/${shape}`; if (sprites.has(key)) return sprites.get(key);
    const off = document.createElement('canvas'); off.width = off.height = 48; const c = off.getContext('2d');
    const g = c.createRadialGradient(24, 24, radius, 24, 24, radius + 13);
    g.addColorStop(0, color + '85'); g.addColorStop(.35, color + '30'); g.addColorStop(1, color + '00');
    c.fillStyle = g; c.fillRect(0, 0, 48, 48);
    c.beginPath();
    if (shape === 'diamond') { c.moveTo(24, 24 - radius - 2); c.lineTo(24 + radius, 24); c.lineTo(24, 24 + radius + 2); c.lineTo(24 - radius, 24); c.closePath(); }
    else c.arc(24, 24, radius, 0, TAU);
    c.fillStyle = color; c.fill(); c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
    c.beginPath(); c.arc(22.6, 22.6, Math.max(1.2, radius * .43), 0, TAU); c.fillStyle = '#fffce9'; c.fill();
    sprites.set(key, off); return off;
  }
  function drawBullet(b, alpha = 1) { ctx.globalAlpha = alpha; ctx.drawImage(bulletSprite(b.color, b.radius, b.shape), b.x - 24, b.y - 24); }
  function polygon(sides, radius, angle = 0) {
    ctx.beginPath(); for (let i = 0; i < sides; i++) { const a = angle + i * TAU / sides; i ? ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius) : ctx.moveTo(Math.cos(a) * radius, Math.sin(a) * radius); } ctx.closePath();
  }
  function drawBackground() {
    ctx.fillStyle = '#f7faf8'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#d4e4e233'; ctx.lineWidth = 1;
    const offset = mode === 'paused' ? 0 : clock * 7 % 40;
    ctx.beginPath(); for (let x = 0; x <= W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = offset - 40; y <= H; y += 40) { ctx.moveTo(0, y); ctx.lineTo(W, y); } ctx.stroke();
    ctx.fillStyle = '#98b8b93d';
    for (let i = 0; i < 46; i++) { const x = (i * 173.3 + 21) % W, y = (i * 113.7 + clock * (5 + i % 4)) % H; ctx.fillRect(x, y, 1.5, 1.5); }
    ctx.strokeStyle = '#a6c1c14d'; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) { const x = (i * 149 + 51) % W, y = (i * 193 + clock * 8) % H; ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke(); }
    ctx.strokeStyle = '#b1cbcb70';
    for (const [x, y, sx, sy] of [[15,15,1,1],[W-15,15,-1,1],[15,H-15,1,-1],[W-15,H-15,-1,-1]]) { ctx.beginPath(); ctx.moveTo(x + sx * 14, y); ctx.lineTo(x,y); ctx.lineTo(x,y + sy * 14); ctx.stroke(); }
  }
  function drawBoss(b, decorative = false) {
    const c = b.config.color, t = decorative ? clock * .6 : b.t;
    ctx.save(); ctx.translate(b.x, b.y);
    ctx.shadowColor = c + '70'; ctx.shadowBlur = 22;
    if (!decorative && b.shield > 0) { ctx.globalAlpha = .5; ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, 69, clock, clock + Math.PI * 1.5); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.rotate(t * (b.config.shape === 3 ? .5 : -.3));
    if (b.config.shape) {
      const n = b.config.shape; polygon(n, 57, -Math.PI / 2); ctx.strokeStyle = c + '60'; ctx.lineWidth = 1; ctx.stroke();
      polygon(n, 42, -Math.PI / 2); ctx.fillStyle = b.hurt > 0 ? '#ffffff' : c + '28'; ctx.fill(); ctx.lineWidth = 2.8; ctx.strokeStyle = c; ctx.stroke();
      ctx.shadowBlur = 0; polygon(n, 29, -Math.PI / 2); ctx.lineWidth = 1; ctx.strokeStyle = c + 'a0'; ctx.stroke();
      ctx.beginPath(); for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * TAU / n; ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*42,Math.sin(a)*42); } ctx.strokeStyle = c + '55'; ctx.stroke();
      for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * TAU / n; ctx.beginPath(); ctx.arc(Math.cos(a)*57,Math.sin(a)*57,3,0,TAU); ctx.fillStyle=c;ctx.fill(); }
    } else {
      ctx.beginPath(); ctx.arc(0,0,43,0,TAU); ctx.fillStyle = b.hurt > 0 ? '#fff' : c + '22'; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(0,0,30,0,TAU); ctx.strokeStyle = c + '88'; ctx.lineWidth = 1; ctx.stroke();
      for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(0,0,57,i*TAU/3,i*TAU/3+1.4);ctx.strokeStyle=c+'99';ctx.lineWidth=2;ctx.stroke();ctx.beginPath();ctx.arc(Math.cos(i*TAU/3)*57,Math.sin(i*TAU/3)*57,4,0,TAU);ctx.fillStyle=c;ctx.fill();}
      ctx.rotate(-t*.8); ctx.scale(1,.43);ctx.beginPath();ctx.arc(0,0,68,0,TAU);ctx.strokeStyle=c+'65';ctx.lineWidth=1.4;ctx.stroke();ctx.scale(1,1/.43);
    }
    ctx.shadowBlur = 13; ctx.shadowColor = c; polygon(4, 10, Math.PI / 4 + t); ctx.fillStyle=c;ctx.fill();ctx.shadowBlur=0;
    ctx.beginPath();ctx.arc(0,0,3,0,TAU);ctx.fillStyle='#fff';ctx.fill();ctx.restore();
  }
  function drawPlayer(p, decorative = false) {
    const blink = !decorative && p.invulnerable > 0 && Math.floor(clock * 13) % 2 === 0;
    ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.tilt || 0); ctx.globalAlpha=blink?.40:1;
    const engine = 12 + Math.sin(clock * 32) * 5;
    const glow = ctx.createLinearGradient(0,9,0,42); glow.addColorStop(0,'#0fb5ba80');glow.addColorStop(1,'#0fb5ba00');
    ctx.fillStyle=glow;ctx.beginPath();ctx.moveTo(-5,11);ctx.lineTo(0,32+engine);ctx.lineTo(5,11);ctx.fill();
    ctx.shadowColor='#12b7bf75';ctx.shadowBlur=18;ctx.beginPath();ctx.moveTo(0,-22);ctx.lineTo(19,18);ctx.lineTo(0,9);ctx.lineTo(-19,18);ctx.closePath();ctx.fillStyle='#21b7bc';ctx.fill();
    ctx.strokeStyle='#0c8f9a';ctx.lineWidth=1.4;ctx.stroke();ctx.shadowBlur=0;
    ctx.beginPath();ctx.moveTo(0,-15);ctx.lineTo(6,9);ctx.lineTo(0,5);ctx.lineTo(-6,9);ctx.closePath();ctx.fillStyle='#a5eeeb';ctx.fill();
    ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.stroke();
    // The visible 4px white square is the actual 2px-radius core, not the ship silhouette.
    ctx.fillStyle='#fff';ctx.fillRect(-2,-2,4,4);ctx.strokeStyle='#0c697a';ctx.strokeRect(-2.5,-2.5,5,5);
    if (p.focus && !decorative) { ctx.globalAlpha=.7;ctx.setLineDash([3,5]);ctx.beginPath();ctx.arc(0,0,23,0,TAU);ctx.lineWidth=1;ctx.strokeStyle='#0aa7ad';ctx.stroke();ctx.setLineDash([]); }
    if (p.invulnerable > 0 && !decorative) {ctx.globalAlpha=.35;ctx.beginPath();ctx.arc(0,0,29,clock*2,clock*2+4.5);ctx.strokeStyle='#17b3bb';ctx.lineWidth=1.2;ctx.stroke();}
    ctx.restore();
  }
  function drawTitle() {
    // An animated attract screen gives an honest preview of the actual geometric art and projectiles.
    const bx=W*.74, by=bossBaseY;
    drawBoss({config:bosses[0],x:bx,y:by,t:clock*.5,hurt:0},true);
    for(let arm=0;arm<3;arm++)for(let i=0;i<34;i++){
      const r=(i*15+clock*25)%450,a=arm*TAU/3-i*.17+clock*.22;
      drawBullet({x:bx+Math.cos(a)*r,y:by+Math.sin(a)*r,color:arm===1?palette[1]:palette[0],radius:4,shape:'orb'},.28+Math.min(.22,r/1800));
    }
    ctx.globalAlpha=1;
    ctx.save();ctx.globalAlpha=.60;drawPlayer({x:W*.50,y:H-82,tilt:Math.sin(clock)*.08,invulnerable:0},true);ctx.restore();
    ctx.save();ctx.strokeStyle='#4fbdc447';ctx.setLineDash([3,8]);ctx.beginPath();ctx.moveTo(W*.5,H-117);ctx.lineTo(W*.5,H-177);ctx.stroke();ctx.restore();
  }
  function draw() {
    ctx.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);ctx.globalAlpha=1;drawBackground();
    ctx.save();
    if(!reducedFX&&shake>0){const power=shake*shake*8;ctx.translate(Math.sin(clock*51)*power,Math.sin(clock*67)*power);}
    if(mode==='title'){drawTitle();}else{
      for(const s of shots){ctx.globalAlpha=.25;ctx.fillStyle='#11b8bf';ctx.fillRect(s.x-2,s.y-6,4,22);ctx.globalAlpha=1;ctx.fillStyle='#50cbd0';ctx.fillRect(s.x-1.5,s.y-11,3,18);ctx.fillStyle='#e6fffa';ctx.fillRect(s.x-.5,s.y-11,1,12);}
      for(const b of bullets)drawBullet(b);
      ctx.globalAlpha=1;if(boss)drawBoss(boss);if(player&&lives>0)drawPlayer(player);
    }
    for(const r of rings){ctx.globalAlpha=clamp(r.life,0,1)*.6;ctx.strokeStyle=r.color;ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(r.x,r.y,r.r,0,TAU);ctx.stroke();}
    for(const p of particles){ctx.globalAlpha=clamp(p.life/p.maxLife,0,1);ctx.fillStyle=p.color;ctx.fillRect(p.x-p.size/2,p.y-p.size/2,p.size,p.size);}
    ctx.globalAlpha=1;ctx.textAlign='center';ctx.font='12px "Microsoft YaHei", sans-serif';
    for(const f of floaters){ctx.globalAlpha=clamp(f.life*1.6,0,1);ctx.fillStyle=f.color;ctx.fillText(f.text,f.x,f.y);}
    ctx.globalAlpha=1;ctx.restore();
    if(flash>0&&!reducedFX){ctx.fillStyle=`rgba(255,255,255,${Math.min(.48,flash*1.8)})`;ctx.fillRect(0,0,W,H);}
    if(hudDirty)updateHUD();
  }
  function frame(now) {
    const delta=Math.min(.10,(now-lastTime)/1000);lastTime=now;
    // Fixed 120Hz simulation keeps collision, diagonal speed and patterns consistent across refresh rates.
    if(mode!=='paused'){accumulator+=delta;while(accumulator>=1/120){update(1/120);accumulator-=1/120;}}
    draw();frameId=requestAnimationFrame(frame);
  }

  const prevented = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','KeyX','KeyP','Escape']);
  addEventListener('keydown',e=>{
    if(prevented.has(e.code))e.preventDefault();
    if(e.code==='KeyM'&&!e.repeat){toggleSound();return;}
    if((e.code==='Escape'||e.code==='KeyP')&&!e.repeat){mode==='paused'?resume():pause();return;}
    if(e.code==='Enter'&&!e.repeat&&e.target.tagName!=='BUTTON'){if(mode==='title'||mode==='gameover'||mode==='victory')start();else if(mode==='paused')resume();return;}
    if(mode!=='playing')return;
    keys.add(e.code);
    if((e.code==='Space'||e.code==='KeyX')&&!e.repeat)useBomb();
  });
  addEventListener('keyup',e=>keys.delete(e.code));
  addEventListener('blur',()=>{keys.clear();pointer=null;pause();persistScore(score);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){pause();persistScore(score);}lastTime=performance.now();accumulator=0;});
  addEventListener('pagehide',()=>persistScore(score));
  function pointerPosition(e) {
    const r=canvas.getBoundingClientRect();
    return {x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H,scaleX:W/r.width,scaleY:H/r.height,offset:74*H/r.height};
  }
  function pointerDown(e) {
    if(mode!=='playing'||pointer||(e.pointerType==='mouse'&&e.button!==0))return;
    e.preventDefault();audio.unlock();e.currentTarget.setPointerCapture(e.pointerId);
    const p=pointerPosition(e), direct=e.currentTarget===canvas&&e.pointerType!=='mouse';
    pointer={id:e.pointerId,kind:e.pointerType,source:e.currentTarget,direct,startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastY:e.clientY,startAt:performance.now(),maxMove:0,targetX:direct?clamp(p.x,18,W-18):player.x,targetY:direct?clamp(p.y-p.offset,flightTop,H-28):player.y};
    $('touch-pad').classList.toggle('active',e.currentTarget===$('touch-pad'));
  }
  function pointerMove(e) {
    if(!pointer||pointer.id!==e.pointerId)return;e.preventDefault();const p=pointerPosition(e);
    if(pointer.direct){pointer.targetX=clamp(p.x,18,W-18);pointer.targetY=clamp(p.y-p.offset,flightTop,H-28);}
    else{
      const gain=e.pointerType==='mouse'?1:1.2;
      pointer.targetX=clamp(pointer.targetX+(e.clientX-pointer.lastX)*p.scaleX*gain,18,W-18);
      pointer.targetY=clamp(pointer.targetY+(e.clientY-pointer.lastY)*p.scaleY*gain,flightTop,H-28);
    }
    pointer.lastX=e.clientX;pointer.lastY=e.clientY;
    pointer.maxMove=Math.max(pointer.maxMove,Math.hypot(e.clientX-pointer.startX,e.clientY-pointer.startY));
  }
  function pointerUp(e){
    if(!pointer||pointer.id!==e.pointerId)return;e.preventDefault();
    const now=performance.now();
    if(e.type==='pointerup'&&pointer.kind!=='mouse'&&pointer.maxMove<15&&now-pointer.startAt<270){
      if(lastTap&&lastTap.source===pointer.source&&now-lastTap.time<320&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<55){useBomb();lastTap=null;}
      else lastTap={time:now,x:e.clientX,y:e.clientY,source:pointer.source};
    }else lastTap=null;
    pointer=null;$('touch-pad').classList.remove('active');
  }
  for(const surface of [canvas,$('touch-pad')]){
    surface.addEventListener('pointerdown',pointerDown);surface.addEventListener('pointermove',pointerMove);
    surface.addEventListener('pointerup',pointerUp);surface.addEventListener('pointercancel',pointerUp);
    surface.addEventListener('lostpointercapture',e=>{if(pointer?.id===e.pointerId){pointer=null;$('touch-pad').classList.remove('active');}});
    surface.addEventListener('contextmenu',e=>e.preventDefault());
  }
  function toggleSound(){soundEnabled=!soundEnabled;$('sound-button').setAttribute('aria-pressed',String(soundEnabled));$('sound-button').setAttribute('aria-label',soundEnabled?'关闭音效':'开启音效');if(soundEnabled){audio.unlock();audio.play('graze');}}
  $('sound-button').addEventListener('click',toggleSound);
  $('fx-button').setAttribute('aria-pressed',String(reducedFX));
  $('fx-button').addEventListener('click',()=>{reducedFX=!reducedFX;$('fx-button').setAttribute('aria-pressed',String(reducedFX));});
  $('layout-button').addEventListener('click',()=>{focusLayout=!focusLayout;try{localStorage.setItem('danmaku-focus-layout',String(focusLayout));}catch{}fitDisplay();draw();});
  $('fullscreen-button').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen({navigationUI:'hide'});}catch{focusLayout=true;fitDisplay();$('fullscreen-button').title='已切换为专注竖屏布局';}});
  $('start-button').addEventListener('click',start);$('retry-button').addEventListener('click',start);$('restart-paused').addEventListener('click',start);
  $('resume-button').addEventListener('click',resume);$('pause-button').addEventListener('click',pause);$('home-button').addEventListener('click',home);
  $('touch-bomb').addEventListener('click',()=>useBomb());
  addEventListener('resize',scheduleDisplay);addEventListener('orientationchange',scheduleDisplay);
  primaryPointer.addEventListener('change',scheduleDisplay);
  document.addEventListener('fullscreenchange',scheduleDisplay);
  window.visualViewport?.addEventListener('resize',scheduleDisplay);
  const displayObserver=new ResizeObserver(scheduleDisplay);displayObserver.observe(document.querySelector('.layout'));displayObserver.observe($('arena'));
  fitDisplay();$('start-button').focus({preventScroll:true});updateHUD();frameId=requestAnimationFrame(frame);

  // Opt-in inspection for deterministic development checks; never present in the normal player UI.
  if(new URLSearchParams(location.search).has('test'))window.__game={
    start,pause,resume,useBomb,damageBoss,damagePlayer,storageReady,
    snapshot:()=>({mode,bossIndex,defeated,score,best,grazes,lives,bombs,elapsed,phase:boss?.phase,hp:boss?.hp,bullets:bullets.length,shots:shots.length,player:player?{...player}:null,persistence,audioState:audio.context?.state,world:{width:W,height:H,flightTop,renderDpr},compact:document.body.classList.contains('compact-layout'),control:pointer?{kind:pointer.kind,direct:pointer.direct,targetX:pointer.targetX,targetY:pointer.targetY}:null}),
    stop:()=>cancelAnimationFrame(frameId),step:(seconds)=>{for(let t=0;t<seconds;t+=1/120)update(1/120);draw();},
    setup:(values)=>{if(values.invulnerable!==undefined)player.invulnerable=values.invulnerable;if(values.x!==undefined)player.x=values.x;if(values.y!==undefined)player.y=values.y;if(values.bombs!==undefined)bombs=values.bombs;if(values.clearBullets)bullets=[];if(values.shield!==undefined&&boss)boss.shield=values.shield;hudDirty=true;},
    emit:(b)=>spawn(b.x,b.y,b.angle??0,b.speed??0,b.color??palette[0],b.radius??5,b.turn??0),
    save:()=>persistScore(score),saved:()=>savePromise,draw,
  };
})();
