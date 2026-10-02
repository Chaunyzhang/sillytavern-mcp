import { chromium } from 'playwright';

export class Bridge {
  constructor() { this.browser = null; this.page = null; this.busy = false; }
  async ready() {
    if (this.page && !this.page.isClosed()) return this.page;
    const url = new URL(process.env.ST_URL || 'http://127.0.0.1:8000');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('ST_URL must use a loopback host.');
    this.browser = await chromium.launch({ channel: process.env.ST_BROWSER_CHANNEL || 'msedge', headless: true });
    this.page = await this.browser.newPage();
    try {
      await this.page.goto(url.href);
      await this.page.waitForFunction(() => window.SillyTavern?.getContext()?.characters?.length > 0 && !SillyTavern.getContext().loader.isBlocking(), null, { timeout: 30000 });
      return this.page;
    } catch (error) { await this.close(); throw new Error('Cannot initialize SillyTavern. Start it first and check login requirements. ' + error.message); }
  }
  async exclusive(fn) {
    if (this.busy) throw new Error('Another operation is running; poll its job before making changes.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async api(endpoint, body = {}) {
    const page = await this.ready();
    return page.evaluate(async ({ endpoint, body }) => {
      const response = await fetch('/api/' + endpoint, { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
      const text = await response.text();
      let result; try { result = JSON.parse(text); } catch { return { ok: true }; }
      if (result?.error) throw new Error(`${endpoint}: ${JSON.stringify(result.error)}`);
      return result;
    }, { endpoint, body });
  }
  async status() {
    const page = await this.ready();
    return page.evaluate(() => {
      const c = SillyTavern.getContext();
      return { api: c.mainApi, onlineStatus: c.onlineStatus, characterCount: c.characters.length, chatId: c.chatId };
    });
  }
  async run({ avatar, chat_name, messages, timeout_seconds }, progress) {
    const page = await this.ready();
    // Reload saved presets and world-book caches before each independent workflow.
    await page.reload();
    await page.waitForFunction(() => window.SillyTavern?.getContext()?.characters?.length > 0 && !SillyTavern.getContext().loader.isBlocking(), null, { timeout: 30000 });
    await page.evaluate(async ({ avatar, chat_name }) => {
      const c = SillyTavern.getContext();
      await c.getCharacters();
      const index = SillyTavern.getContext().characters.findIndex(x => x.avatar === avatar);
      if (index < 0) throw new Error('Character not found: ' + avatar);
      await c.selectCharacterById(index, { switchMenu: false });
      if (String(SillyTavern.getContext().characterId) !== String(index)) throw new Error('Character selection failed');
      await c.openCharacterChat(chat_name);
      if (SillyTavern.getContext().chatId !== chat_name) throw new Error('Chat selection failed');
      const ctx = SillyTavern.getContext();
      if (ctx.onlineStatus === 'no_connection') {
        const selectors = { openai: '#api_button_openai', kobold: '#api_button', textgenerationwebui: '#api_button_textgenerationwebui' };
        document.querySelector(selectors[ctx.mainApi] || '#nonexistent')?.click();
      }
    }, { avatar, chat_name });
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== 'no_connection', null, { timeout: 30000 });
    const replies = [];
    for (const message of messages) {
      const reply = await page.evaluate(async ({ message, timeout_seconds }) => {
        const c = SillyTavern.getContext();
        const user = { name: c.name1, is_user: true, is_system: false, send_date: new Date().toISOString(), mes: message, extra: {} };
        c.chat.push(user);
        c.addOneMessage(user);
        await c.saveChat();
        const start = c.chat.length;
        const controller = new AbortController();
        let timer;
        const generation = c.generate('normal', { signal: controller.signal, automatic_trigger: true });
        try {
          await Promise.race([generation, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); c.stopGeneration(); reject(new Error('Generation timed out; inspect the chat before retrying.')); }, timeout_seconds * 1000); })]);
        } finally { clearTimeout(timer); }
        const result = c.chat.slice(start).filter(x => !x.is_user && !x.is_system).map(x => ({ name: x.name, text: x.mes }));
        if (!result.length) throw new Error('No assistant reply. Check model connection and SillyTavern settings.');
        await c.saveChat();
        return result;
      }, { message, timeout_seconds });
      replies.push(...reply);
      progress(replies);
    }
    return { avatar, chat_name, replies };
  }
  async close() { await this.browser?.close(); this.browser = null; this.page = null; }
}
