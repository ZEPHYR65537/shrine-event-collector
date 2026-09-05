// ==UserScript==
// @name         神社记录采集器
// @namespace    shrine-event-study
// @version      2.0.0
// @updateURL    https://raw.githubusercontent.com/ZEPHYR65537/shrine-event-collector/main/shrine-event-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/ZEPHYR65537/shrine-event-collector/main/shrine-event-collector.user.js
// @description  扫描全部神社事件，保存断点，显示总收入并分享签名增量包。
// @match        https://bbs.acgn.at/*
// @match        https://bbs2.kdays.net/*
// @match        https://b.schale.moe/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* global GM_getValue, GM_setValue, GM_listValues, module */
(function () {
  "use strict";
  const PREFIX = "shrine.v2.";
  const CREDIT_PATH = "/my/credit";
  const AUTO_SCAN_HASH = "#shrine-collector-scan";
  const PAGE_DELAY_MS = 600;
  const TIMEOUT_MS = 20000;
  const MAX_RETRIES = 2;
  const LEASE_MS = 60000;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const fail = (message) => { throw new Error(message); };
  const integer = Number.isSafeInteger;

  function canonicalize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  function exactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail(`${label} 字段无效`);
  }
  function timestamp(value) {
    if (typeof value !== "string") fail("日志时间无效");
    const match = value.trim().match(/^(20\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) fail(`无法识别日志时间：${value}`);
    const result = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}${match[6] ? `:${match[6]}` : ""}`;
    // Validate the calendar, without assigning a timezone to the forum's displayed time.
    const iso = `${result.replace(" ", "T")}${match[6] ? "" : ":00"}Z`;
    const date = new Date(iso);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19)) fail("日志日期无效");
    return result;
  }
  function delta(value, metric) {
    const unit = metric === 0 ? "(?:KB)?" : "(?:BBT|根)?";
    const match = String(value).trim().replace(/−/g, "-").match(new RegExp(`^([+-]?\\d+)\\s*${unit}$`, "i"));
    if (!match || !integer(Number(match[1]))) fail(`无法识别神社积分变动：${value}`);
    return Number(match[1]);
  }
  // Only shrine rows survive extraction: [metric, delta, number|'cost'].
  function parseRow(type, change, description) {
    description = description.trim();
    if (!/神社\s*时运\s*事件/.test(description)) return null;
    const match = description.match(/^神社\s*时运\s*事件(?:\s*[:：]\s*(cost|\d+))?$/i);
    if (!match) fail(`无法识别神社说明：${description}`);
    const metric = /^(坑币|坑幣)$/.test(type.trim()) ? 0 : type.trim() === "棒棒糖" ? 1 : -1;
    if (metric < 0) fail(`神社条目出现不支持的积分类型：${type}`);
    const kind = match[1]?.toLowerCase() === "cost" ? "cost" : match[1] === undefined ? -1 : Number(match[1]);
    const row = [metric, delta(change, metric), kind];
    validateRow(row);
    return row;
  }
  function validateRow(row) {
    if (!Array.isArray(row) || row.length !== 3 || ![0, 1].includes(row[0]) || !integer(row[1])
      || !(row[2] === "cost" || (integer(row[2]) && row[2] >= -1))) fail("神社条目无效");
  }
  function validateEvent(event) {
    exactKeys(event, ["num", "cost", "res", "time"], "事件");
    if (!integer(event.num) || event.num < -1 || !integer(event.cost) || event.cost < 0 || event.cost > 6
      || !Array.isArray(event.res) || event.res.length !== 2 || !integer(event.res[0]) || !integer(event.res[1])
      || timestamp(event.time) !== event.time) fail("事件内容无效");
    return event;
  }
  function combineBlock(time, rows) {
    timestamp(time);
    if (!rows.length) return null;
    let cost = 0;
    let results = 0;
    const res = [0, 0];
    const numbers = new Set();
    for (const row of rows) {
      validateRow(row);
      const [metric, value, kind] = row;
      if (kind === "cost") {
        if (metric !== 0 || value > 0) fail(`${time}：奉纳条目必须是 KB 扣款`);
        cost -= value;
        if (!integer(cost) || cost > 6) fail(`${time}：奉纳合计不在 0–6 KB 内`);
      } else {
        results++;
        res[metric] += value;
        if (!integer(res[metric])) fail("神社结果超出安全整数范围");
        if (kind >= 0) numbers.add(kind);
      }
    }
    if (!results) fail(`${time}：只有奉纳，没有结果条目；无法确认是否为零结果`);
    if (numbers.size > 1) fail(`${time}：同一显示时间存在不同事件编号`);
    return validateEvent({ num: numbers.size ? [...numbers][0] : -1, cost, res, time });
  }
  const emptyTotals = () => ({ totalDraw: 0, totalCost: 0, totalResult: [0, 0] });
  function addEvent(totals, event) {
    totals.totalDraw++;
    totals.totalCost += event.cost;
    totals.totalResult[0] += event.res[0];
    totals.totalResult[1] += event.res[1];
    if (![totals.totalDraw, totals.totalCost, ...totals.totalResult].every(integer)) fail("累计值超出安全整数范围");
  }
  function validateTotals(totals) {
    exactKeys(totals, ["totalDraw", "totalCost", "totalResult"], "累计统计");
    if (!integer(totals.totalDraw) || totals.totalDraw < 0 || !integer(totals.totalCost)
      || totals.totalCost < 0 || totals.totalCost > 6 * totals.totalDraw
      || !Array.isArray(totals.totalResult) || totals.totalResult.length !== 2
      || !integer(totals.totalResult[0]) || !integer(totals.totalResult[1])) fail("累计统计无效");
  }
  const lifetimeOf = (totals) => ({ totalDraw: totals.totalDraw, totalCost: totals.totalCost, totalResult: [...totals.totalResult] });
  function bytesToBase64Url(bytes) {
    let binary = "";
    const array = new Uint8Array(bytes);
    for (let offset = 0; offset < array.length; offset += 8192) binary += String.fromCharCode(...array.subarray(offset, offset + 8192));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail("签名编码无效");
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), (ch) => ch.charCodeAt(0));
    if (bytesToBase64Url(bytes) !== value) fail("签名编码不规范");
    return bytes;
  }
  async function digest(value) {
    return bytesToBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : canonicalize(value))));
  }
  const validHash = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  const validRef = (value) => value === null || validHash(value);
  const importPublic = (publicKey) => crypto.subtle.importKey("spki", base64UrlToBytes(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  async function sign(key, content, local = false) {
    const bytes = new TextEncoder().encode((local ? "shrine-local-v2\n" : "") + canonicalize(content));
    return bytesToBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes));
  }
  async function verify(key, content, signature, local = false) {
    try {
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlToBytes(signature),
        new TextEncoder().encode((local ? "shrine-local-v2\n" : "") + canonicalize(content)));
    } catch { return false; }
  }
  async function createIdentity(kv) {
    let saved = await kv.get(`${PREFIX}identity`, null);
    if (saved === null) {
      if ((await kv.keys()).some((key) => key.startsWith(`${PREFIX}snapshot.`) || key.startsWith(`${PREFIX}share.`)
        || key === `${PREFIX}shareHead`)) fail("签名身份缺失，不能自动替换已有身份；请保留数据后检查存储");
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      saved = { publicKey: bytesToBase64Url(await crypto.subtle.exportKey("spki", pair.publicKey)), privateKey: bytesToBase64Url(await crypto.subtle.exportKey("pkcs8", pair.privateKey)) };
      await kv.set(`${PREFIX}identity`, saved);
      if (canonicalize(await kv.get(`${PREFIX}identity`, null)) !== canonicalize(saved)) fail("签名身份保存失败");
    }
    exactKeys(saved, ["publicKey", "privateKey"], "签名身份");
    const publicCryptoKey = await importPublic(saved.publicKey);
    const privateCryptoKey = await crypto.subtle.importKey("pkcs8", base64UrlToBytes(saved.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    if (!await verify(publicCryptoKey, "identity-check", await sign(privateCryptoKey, "identity-check", true), true)) fail("本地公私钥不匹配");
    return { publicKey: saved.publicKey, publicCryptoKey, privateCryptoKey };
  }
  async function verifyBundle(bundle) {
    exactKeys(bundle, ["publicKey", "sequence", "previousBundleHash", "packedAt", "lifetime", "events", "signature"], "分享包");
    const { signature, ...content } = bundle;
    if (!integer(bundle.sequence) || bundle.sequence < 1 || !validRef(bundle.previousBundleHash)
      || (bundle.sequence === 1) !== (bundle.previousBundleHash === null)) fail("分享包序号或前序哈希无效");
    if (typeof bundle.packedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(bundle.packedAt)
      || new Date(bundle.packedAt).toISOString() !== bundle.packedAt) fail("打包时间无效");
    validateTotals(bundle.lifetime);
    const { totalDraw, totalResult } = bundle.lifetime;
    if (!integer(totalDraw) || totalDraw < 0 || !Array.isArray(totalResult) || totalResult.length !== 2
      || !totalResult.every(integer) || (totalDraw === 0 && totalResult.some((value) => value !== 0))) fail("生涯汇总无效");
    if (!Array.isArray(bundle.events) || bundle.events.length > totalDraw) fail("事件数组无效");
    const times = new Set();
    for (const event of bundle.events) { validateEvent(event); if (times.has(event.time)) fail("分享包内事件时间重复"); times.add(event.time); }
    if (!await verify(await importPublic(bundle.publicKey), content, signature)) fail("分享包数字签名验证失败");
    return { hash: await digest(bundle), contributorId: await digest(bundle.publicKey) };
  }

  function emptyState() {
    return { revision: 0, parent: null, events: [], baseline: null, job: null };
  }
  function sumEvents(events) {
    const totals = emptyTotals();
    for (const event of events) addEvent(totals, event);
    return totals;
  }

  // Two complete signed snapshots, not a database of pages. The older slot is the backup.
  class Repository {
    constructor(kv, identity, assertWriter = async () => {}) {
      this.kv = kv;
      this.identity = identity;
      this.assertWriter = assertWriter;
      this.state = emptyState();
      this.head = null;
      this.events = new Map();
      this.shared = new Map();
      this.lastBundle = null;
      this.notice = "";
      this.slots = [null, null];
    }
    totals() { return sumEvents(this.state.events); }
    baselineTotals() { return sumEvents(this.state.events.slice(0, this.state.baseline?.count ?? 0)); }
    async envelope(content) {
      return { content, signature: await sign(this.identity.privateCryptoKey, content, true) };
    }
    validateState(state) {
      exactKeys(state, ["revision", "parent", "events", "baseline", "job"], "扫描快照");
      if (!integer(state.revision) || state.revision < 1 || !validRef(state.parent) || !Array.isArray(state.events)) fail("扫描快照无效");
      const times = new Set();
      for (const event of state.events) {
        validateEvent(event);
        if (times.has(event.time)) fail("本地事件时间重复");
        times.add(event.time);
      }
      sumEvents(state.events); // Also verifies overflow in cumulative values.
      if (state.baseline) {
        const base = state.baseline;
        exactKeys(base, ["upper", "count"], "完整扫描基线");
        if (!integer(base.count) || base.count < 0 || base.count > state.events.length
          || !(base.upper === null || timestamp(base.upper) === base.upper)
          || state.events.slice(0, base.count).some((event) => base.upper === null || event.time > base.upper)) fail("完整扫描基线无效");
      }
      if (state.job) {
        const job = state.job;
        exactKeys(job, ["upper", "cursor"], "扫描任务");
        if (timestamp(job.upper) !== job.upper || !(job.cursor === null || timestamp(job.cursor) === job.cursor)
          || (job.cursor !== null && (job.cursor > job.upper || job.cursor.length !== job.upper.length))
          || (state.baseline?.upper && (job.upper < state.baseline.upper || job.upper.length !== state.baseline.upper.length))) fail("扫描任务边界无效");
        for (const event of state.events.slice(state.baseline?.count ?? 0)) {
          if (job.cursor === null || event.time < job.cursor || event.time > job.upper) fail("事件超出已确认扫描区间");
        }
      } else if (state.baseline) {
        if (state.baseline.count !== state.events.length) fail("完整扫描的事件数量不一致");
      } else if (state.events.length) fail("缺少事件覆盖范围");
    }
    async loadShares() {
      const packages = [];
      for (const key of (await this.kv.keys()).filter((name) => name.startsWith(`${PREFIX}share.`))) {
        const bundle = await this.kv.get(key, null);
        const { hash } = await verifyBundle(bundle);
        if (key !== `${PREFIX}share.${hash}` || bundle.publicKey !== this.identity.publicKey) fail("本地分享历史校验失败");
        packages.push({ hash, bundle });
      }
      packages.sort((a, b) => a.bundle.sequence - b.bundle.sequence);
      const shared = new Map();
      const totals = emptyTotals();
      let previousHash = null;
      for (let i = 0; i < packages.length; i++) {
        const { hash, bundle } = packages[i];
        if (bundle.sequence !== i + 1 || bundle.previousBundleHash !== previousHash) fail("本地分享历史缺包或分叉，请保留数据后核查");
        for (const event of bundle.events) {
          if (shared.has(event.time)) fail("本地分享包重复包含同次事件");
          shared.set(event.time, canonicalize(event));
          addEvent(totals, event);
        }
        if (canonicalize(lifetimeOf(totals)) !== canonicalize(bundle.lifetime)) fail("本地分享汇总与事件历史不一致");
        previousHash = hash;
      }
      const tip = await this.kv.get(`${PREFIX}shareHead`, null);
      if (tip !== null) {
        exactKeys(tip, ["content", "signature"], "分享进度签名");
        exactKeys(tip.content, ["sequence", "hash"], "分享进度");
        if (!integer(tip.content.sequence) || tip.content.sequence < 1 || !validHash(tip.content.hash)
          || !await verify(this.identity.publicCryptoKey, tip.content, tip.signature, true)) fail("分享进度签名无效，请保留数据后核查");
        if (packages[tip.content.sequence - 1]?.hash !== tip.content.hash) fail("已分享的数据包缺失，请恢复原包；重新扫描不能恢复原签名包");
      }
      if (packages.length > (tip?.content.sequence ?? 0) + 1) fail("分享进度缺失或存在多个未确认包，未重置序号");
      this.shareTip = tip;
      this.shared = shared;
      this.lastBundle = packages.at(-1)?.bundle ?? null;
    }
    async saveShareHead() {
      if (!this.lastBundle) return;
      await this.assertUnchanged();
      if (canonicalize(await this.kv.get(`${PREFIX}shareHead`, null)) !== canonicalize(this.shareTip)) fail("另一窗口改变了分享进度");
      const content = { sequence: this.lastBundle.sequence, hash: await digest(this.lastBundle) };
      if (canonicalize(content) === canonicalize(this.shareTip?.content ?? null)) return;
      const envelope = await this.envelope(content);
      await this.assertWriter();
      await this.kv.set(`${PREFIX}shareHead`, envelope);
      await this.assertWriter();
      if (canonicalize(await this.kv.get(`${PREFIX}shareHead`, null)) !== canonicalize(envelope)) fail("分享进度保存失败，尚未下载");
      this.shareTip = envelope;
    }
    async load(rebuild = false) {
      await this.loadShares();
      const candidates = [];
      let damaged = false;
      for (let index = 0; index < 2; index++) {
        const envelope = await this.kv.get(`${PREFIX}snapshot.${index}`, null);
        this.slots[index] = canonicalize(envelope);
        if (envelope === null) continue;
        try {
          exactKeys(envelope, ["content", "signature"], "签名快照");
          if (!await verify(this.identity.publicCryptoKey, envelope.content, envelope.signature, true)) fail("快照签名无效");
          this.validateState(envelope.content);
          if (envelope.content.revision % 2 !== index) fail("快照位置不一致");
          candidates.push({ state: envelope.content, hash: await digest(envelope) });
        } catch { damaged = true; }
      }
      candidates.sort((a, b) => a.state.revision - b.state.revision);
      if (candidates.length === 2 && (candidates[1].state.revision !== candidates[0].state.revision + 1
        || candidates[1].state.parent !== candidates[0].hash)) fail("两个有效快照不属于同一条更新链；请停止其他窗口后核查，未覆盖数据");
      if (candidates.length) {
        const chosen = candidates.at(-1);
        this.state = chosen.state;
        this.head = chosen.hash;
        this.events = new Map(this.state.events.map((event) => [event.time, event]));
        if (damaged) this.notice = "部分本地快照损坏，已恢复有效备份；尾部将重新扫描。";
        return true;
      }
      this.state = emptyState();
      this.head = null;
      this.events = new Map();
      if (damaged) this.notice = "本地快照均失效，需重新扫描；签名身份和分享历史保留。";
      if (!rebuild) return false;
      await this.commit(this.state);
      return true;
    }
    async assertUnchanged() {
      await this.assertWriter();
      for (let i = 0; i < 2; i++) {
        if (canonicalize(await this.kv.get(`${PREFIX}snapshot.${i}`, null)) !== this.slots[i]) fail("另一窗口或外部操作改变了扫描数据，请重新校验后继续");
      }
    }
    async commit(next) {
      await this.assertUnchanged();
      const state = clone(next);
      state.revision = this.state.revision + 1;
      state.parent = this.head;
      this.validateState(state);
      const envelope = await this.envelope(state);
      const index = state.revision % 2;
      // Signing can take time: verify ownership and predecessor once more before writing.
      await this.assertUnchanged();
      await this.kv.set(`${PREFIX}snapshot.${index}`, envelope);
      await this.assertWriter();
      const saved = await this.kv.get(`${PREFIX}snapshot.${index}`, null);
      if (canonicalize(saved) !== canonicalize(envelope)) fail("扫描快照保存失败");
      if (canonicalize(await this.kv.get(`${PREFIX}snapshot.${1 - index}`, null)) !== this.slots[1 - index]) fail("保存时出现并发更新，请重新校验数据");
      this.slots[index] = canonicalize(envelope);
      this.head = await digest(envelope);
      this.state = state;
      this.events = new Map(state.events.map((event) => [event.time, event]));
    }
    async prepareShare(now = new Date().toISOString()) {
      if (!this.state.baseline) fail("首次扫描尚未完成，暂不能分享");
      await this.assertUnchanged();
      await this.loadShares();
      // Recover a package saved just before a crash, before returning it or creating its successor.
      await this.saveShareHead();
      const records = this.state.events.slice(0, this.state.baseline.count);
      const byTime = new Map(records.map((event) => [event.time, canonicalize(event)]));
      for (const [time, content] of this.shared) {
        if (byTime.get(time) !== content) fail("完整基线缺少已分享事件或内容不一致；请完成重扫后核查，未修改分享历史");
      }
      const events = records.filter((event) => !this.shared.has(event.time)).sort((a, b) => a.time.localeCompare(b.time));
      const lifetime = lifetimeOf(sumEvents(records));
      if (this.lastBundle && !events.length && canonicalize(lifetime) === canonicalize(this.lastBundle.lifetime)) return this.lastBundle;
      const content = { publicKey: this.identity.publicKey, sequence: (this.lastBundle?.sequence ?? 0) + 1,
        previousBundleHash: this.lastBundle ? await digest(this.lastBundle) : null, packedAt: now, lifetime, events };
      const bundle = { ...content, signature: await sign(this.identity.privateCryptoKey, content) };
      const { hash } = await verifyBundle(bundle);
      await this.assertUnchanged();
      await this.kv.set(`${PREFIX}share.${hash}`, bundle);
      await this.assertWriter();
      if (canonicalize(await this.kv.get(`${PREFIX}share.${hash}`, null)) !== canonicalize(bundle)) fail("分享包保存失败，尚未下载");
      await this.loadShares();
      await this.saveShareHead();
      return bundle;
    }
  }

  class PageMoved extends Error {}
  function validatePage(page) {
    if (!integer(page.number) || page.number < 1 || !integer(page.totalPages) || page.totalPages < page.number
      || !Array.isArray(page.entries) || !validHash(page.digest)) fail("积分日志分页结构无效");
    if (!page.entries.length && !page.empty) fail("积分表格尚未加载完成");
    if (!page.entries.length && (page.number !== 1 || page.totalPages !== 1)) fail("空表与分页信息不一致");
    let last = null;
    for (const entry of page.entries) {
      timestamp(entry.time);
      if (last && (entry.time > last || entry.time.length !== last.length)) fail("积分日志顺序或时间精度异常");
      last = entry.time;
      if (entry.row !== null) validateRow(entry.row);
    }
    return page;
  }

  async function runScan(repo, adapter, progress = () => {}) {
    let reads = 0;
    let totalPages = 1;
    let moved = 0;
    const started = Date.now();
    const initialDraws = repo.state.events.length;
    async function read(number) {
      let error;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await repo.assertWriter();
          const page = validatePage(await adapter.read(number));
          if (page.number !== number) fail("翻页后停留在错误页码");
          if (repo.state.job && page.entries.some((entry) => entry.time.length !== repo.state.job.upper.length)) fail("扫描过程中日志时间精度发生变化");
          totalPages = page.totalPages;
          reads++;
          progress({ reads, time: repo.state.job?.cursor, etaMs: Math.max(0, totalPages - number) * (Date.now() - started) / reads, totals: repo.totals() });
          return page;
        } catch (caught) {
          error = caught;
          if (attempt < MAX_RETRIES) await adapter.delay?.(PAGE_DELAY_MS * (attempt + 1));
        }
      }
      throw error;
    }
    async function locate(target) {
      // Page numbers are temporary search coordinates, never stored progress.
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        let candidate = await read(1);
        if (!candidate.entries.length) fail("断点对应的日志已不存在");
        if (candidate.entries.at(-1).time > target) {
          let lo = 2;
          let hi = candidate.totalPages;
          candidate = null;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const page = await read(mid);
            if (page.entries.at(-1).time <= target) { candidate = page; hi = mid - 1; } else lo = mid + 1;
          }
        }
        if (!candidate) fail("无法定位扫描时间，日志可能已被删除");
        if (candidate.number > 1) {
          const previous = await read(candidate.number - 1);
          if (previous.entries.at(-1).time <= target) continue;
          candidate = await read(candidate.number);
        }
        if (candidate.entries.at(-1).time > target) continue;
        if (!candidate.entries.some((entry) => entry.time === target)) fail("未找到完整时间边界，不能确认扫描衔接");
        return candidate;
      }
      fail("定位期间页面持续移动，请稍后继续");
    }
    async function finish(state, upper) {
      state.baseline = { upper, count: state.events.length };
      state.job = null;
      await repo.commit(state);
    }
    let page;
    if (!repo.state.job) {
      page = await read(1);
      const upper = page.entries[0]?.time ?? null;
      if (repo.state.baseline?.upper && (!upper || upper < repo.state.baseline.upper || upper.length !== repo.state.baseline.upper.length)) fail("日志最新时间回退或精度改变，未沿旧统计继续累计");
      if (upper === null) {
        const confirmation = await read(1);
        if (confirmation.entries.length) fail("空表状态发生变化，请重试");
        await finish(clone(repo.state), null);
        return { reads, added: 0 };
      }
      const state = clone(repo.state);
      state.job = { upper, cursor: null };
      await repo.commit(state);
    }
    let boundary = repo.state.job.cursor;
    if (!page) page = await locate(boundary ?? repo.state.job.upper);
    let pending = null;
    while (true) {
      const state = clone(repo.state);
      const job = state.job;
      const previousCursor = job.cursor;
      let done = false;
      try {
        if (!page.entries.length) fail("扫描途中日志变为空表，请核查");
        if (pending) {
          if (page.entries[0].time > pending.time) throw new PageMoved("页面位置已移动");
          const relevantTie = page.entries[0].time === pending.time && (pending.rows.length
            || page.entries.some((entry) => entry.time === pending.time && entry.row));
          if (relevantTie) {
            const guard = await read(pending.guard.number);
            if (guard.digest !== pending.guard.digest) throw new PageMoved("未完成时间组的页边界已移动");
          }
        }
        function close() {
          if (!pending) return;
          const event = combineBlock(pending.time, pending.rows);
          const known = repo.events.get(pending.time) ?? state.events.slice(repo.state.events.length).find((item) => item.time === pending.time);
          if (boundary !== null) {
            if (pending.time !== boundary) fail("未读取完整恢复边界");
            if (canonicalize(event) !== canonicalize(known ?? null)) fail(`${pending.time}：恢复边界事件发生变化，不能继续累计`);
            boundary = null;
          } else {
            if (known && canonicalize(event) !== canonicalize(known)) fail(`${pending.time}：已保存事件出现冲突`);
            if (event && !known) state.events.push(event);
          }
          job.cursor = pending.time;
          if (state.baseline?.upper === pending.time) done = true;
          pending = null;
        }
        const startAt = boundary ?? job.upper;
        for (const entry of page.entries) {
          if (entry.time > startAt) continue;
          if (pending && pending.time !== entry.time) close();
          if (done) break;
          if (state.baseline?.upper && entry.time < state.baseline.upper) fail("未找到上次完整扫描的边界，不能确认增量衔接");
          if (boundary !== null && entry.time < boundary) fail("未找到恢复边界，不能跳过后继续");
          if (!pending) pending = { time: entry.time, rows: [], guard: { number: page.number, digest: page.digest } };
          if (entry.row) pending.rows.push(entry.row);
        }
        let atEnd = false;
        if (!done && page.number >= totalPages) {
          const confirmation = await read(page.number);
          if (confirmation.digest !== page.digest) throw new PageMoved("末页内容发生变化");
          atEnd = page.number === totalPages;
          if (atEnd) close();
        }
        if (done || atEnd) {
          if (state.baseline?.upper && !done) fail("日志结束前没有确认原有覆盖边界");
          await finish(state, job.upper);
          return { reads, added: repo.state.events.length - initialDraws };
        }
        if (job.cursor !== repo.state.job.cursor || state.events.length !== repo.state.events.length) await repo.commit(state);
        if (repo.state.job.cursor !== previousCursor) moved = 0;
        await adapter.delay?.(PAGE_DELAY_MS);
        page = await read(page.number + 1);
      } catch (error) {
        if (!(error instanceof PageMoved) || ++moved > MAX_RETRIES) throw error;
        pending = null;
        boundary = repo.state.job.cursor;
        page = await locate(boundary ?? repo.state.job.upper);
      }
    }
  }

  const api = { PREFIX, canonicalize, timestamp, parseRow, validateRow, combineBlock, validateEvent,
    emptyTotals, addEvent, lifetimeOf, sumEvents, digest, sign, verifyBundle, createIdentity, Repository, validatePage, runScan };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  // Browser integration; keep collection restricted to the rendered credit-log table.
  const browserKv = {
    get: async (key, fallback = null) => GM_getValue(key, fallback),
    set: async (key, value) => GM_setValue(key, value),
    keys: async () => GM_listValues(),
  };
  let browserUi;
  let browserRepo = null;
  let browserBusy = false;

  function creditTab() {
    return [...document.querySelectorAll('button[role="tab"]')].find((tab) => textOf(tab) === "积分日志");
  }
  function findCreditTable() {
    for (const table of document.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      const header = rows.findIndex((row) => canonicalize([...row.querySelectorAll("th, td")].map(textOf))
        === canonicalize(["类型", "变动", "说明", "时间"]));
      if (header >= 0) return { table, rows: rows.slice(header + 1) };
    }
    return null;
  }
  function creditPagination(found = findCreditTable()) {
    const root = found?.table.closest("section.tab-panel")?.querySelector(".log-pagination .pagination");
    if (!root) return { number: 1, totalPages: 1, buttons: [], input: null, jump: null };
    const buttons = [...root.querySelectorAll(".pagination-main button")]
      .map((button) => ({ button, number: Number(textOf(button)) })).filter(({ number }) => integer(number) && number >= 1);
    const active = buttons.filter(({ button }) => button.classList.contains("kd-btn--primary")
      || button.getAttribute("aria-current") === "page");
    if (active.length !== 1 || !buttons.length) fail("积分日志分页结构无法识别");
    return { number: active[0].number, totalPages: Math.max(...buttons.map(({ number }) => number)), buttons,
      input: root.querySelector("input.jump-input"), jump: root.querySelector(".pagination-jumper button") };
  }
  function visibleElement(node) {
    if (!node || node.hidden) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function creditLoading(found = findCreditTable()) {
    const wrapper = found?.table.closest(".loading-overlay-wrapper");
    return wrapper?.getAttribute("aria-busy") === "true" || !!wrapper
      && [...wrapper.querySelectorAll('.loading-overlay, [aria-busy="true"]')].some(visibleElement);
  }
  function readRenderedPage() {
    if (location.pathname.replace(/\/$/, "") !== CREDIT_PATH || creditTab()?.getAttribute("aria-selected") !== "true") {
      fail("积分日志已关闭；请登录后重新点击扫描");
    }
    const found = findCreditTable();
    if (!found || creditLoading(found)) return null;
    const { number, totalPages } = creditPagination(found);
    const entries = [];
    let explicitEmpty = false;
    for (const row of found.rows) {
      const cells = [...row.querySelectorAll("td")];
      if (cells.length === 1 && Number(cells[0].getAttribute("colspan")) >= 4
        && /^(?:暂无(?:积分)?(?:日志|记录|数据)|没有(?:积分)?(?:日志|记录|数据)|No\s+(?:data|records))(?:[。.!！])?$/i.test(textOf(cells[0]))) {
        explicitEmpty = true;
        continue;
      }
      if (cells.length !== 4) return null;
      entries.push({ time: timestamp(textOf(cells[3])), row: parseRow(textOf(cells[0]), textOf(cells[1]), textOf(cells[2])) });
    }
    if (entries.length > 20 || (number < totalPages && entries.length !== 20)) return null;
    if (!entries.length && !explicitEmpty) return null;
    if (explicitEmpty && (entries.length || totalPages !== 1)) fail("空日志提示与分页内容冲突");
    // Neither the digest nor the entries contain other logs' descriptions, types, or amounts.
    return { number, totalPages, entries, empty: explicitEmpty };
  }

  // Observe before clicking: changing the active page alone does not prove new rows arrived.
  // A loading cycle also accepts two pages whose actual contents are exactly equal.
  function waitCreditPage(number, trigger = null) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let busySeen = false;
      let contentChanged = !trigger;
      let stable = null;
      let stableSince = 0;
      const initial = findCreditTable();
      const initialTable = initial?.table;
      const initialBody = initialTable?.querySelector("tbody");
      const finish = (error, page) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timeout);
        if (error) reject(error); else resolve(page);
      };
      const check = (mutations = []) => {
        if (finished) return;
        try {
          const found = findCreditTable();
          if (creditLoading(found)) busySeen = true;
          for (const mutation of mutations) {
            if (mutation.type !== "attributes" && (initialBody?.contains(mutation.target)
              || found?.table.querySelector("tbody")?.contains(mutation.target))) contentChanged = true;
          }
          if (found?.table && (found.table !== initialTable || found.table.querySelector("tbody") !== initialBody)) contentChanged = true;
          if (busySeen && !creditLoading(found)) contentChanged = true;
          const page = readRenderedPage();
          if (!page || page.number !== number || !contentChanged) { stable = null; return; }
          const key = canonicalize(page);
          if (key !== stable) { stable = key; stableSince = Date.now(); return; }
          if (Date.now() - stableSince >= 120) finish(null, page);
        } catch (error) { finish(error); }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-busy", "aria-selected", "disabled"] });
      const poll = setInterval(check, 50);
      const timeout = setTimeout(() => finish(new Error("积分日志翻页未确认加载完成，已暂停；请稍后重试")), TIMEOUT_MS);
      try { trigger?.(); check(); } catch (error) { finish(error); }
    });
  }

  const browserAdapter = {
    delay: sleep,
    async read(number) {
      const current = creditPagination();
      if (!integer(number) || number < 1 || number > current.totalPages) fail(`无法访问积分日志第 ${number} 页`);
      let page;
      if (number === current.number) page = await waitCreditPage(number);
      else {
        let button = current.buttons.find((item) => item.number === number)?.button;
        if (!button || button.disabled) {
          if (!current.input || !current.jump) fail("积分日志缺少跳页控件");
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(current.input), "value")?.set;
          if (setter) setter.call(current.input, String(number)); else current.input.value = String(number);
          current.input.dispatchEvent(new Event("input", { bubbles: true }));
          current.input.dispatchEvent(new Event("change", { bubbles: true }));
          const until = Date.now() + Math.min(3000, TIMEOUT_MS);
          while (Date.now() < until && creditPagination().jump?.disabled) await sleep(50);
          button = creditPagination().jump;
          if (!button || button.disabled) fail("积分日志跳页按钮未启用");
        }
        page = await waitCreditPage(number, () => button.click());
      }
      return { ...page, digest: await digest(page.entries) };
    },
  };

  async function openCreditLog() {
    if (location.pathname.replace(/\/$/, "") !== CREDIT_PATH) {
      location.assign(`${location.origin}${CREDIT_PATH}${AUTO_SCAN_HASH}`);
      return false;
    }
    let clicked = null;
    const until = Date.now() + TIMEOUT_MS;
    while (Date.now() < until) {
      if (location.pathname.replace(/\/$/, "") !== CREDIT_PATH) fail("页面已离开积分页；请登录后重新扫描");
      const tab = creditTab();
      if (tab?.getAttribute("aria-selected") === "true" && findCreditTable()) return true;
      if (tab && !tab.disabled && tab !== clicked && tab.getAttribute("aria-selected") !== "true") {
        clicked = tab;
        tab.click();
      }
      await sleep(100);
    }
    fail("积分日志未能打开；请确认已登录后重试");
  }

  async function withBrowserWriter(task) {
    const run = async () => {
      const key = `${PREFIX}writer`;
      const owner = crypto.randomUUID();
      const leaseMs = 60000;
      const old = await browserKv.get(key);
      if (old?.until > Date.now()) fail("另一窗口正在扫描或分享，请先停止其他窗口的操作");
      const lease = () => ({ owner, until: Date.now() + leaseMs });
      await browserKv.set(key, lease());
      // GM storage has no cross-origin compare-and-swap. Lease checks catch observed races;
      // repository revision checks provide an additional guard, not absolute exclusion.
      await sleep(75);
      let lost = false;
      let renewal = Promise.resolve();
      const assertWriter = async () => {
        const current = await browserKv.get(key);
        if (lost || current?.owner !== owner || current.until <= Date.now()) fail("采集锁已失效或存在并发操作；已停止写入");
      };
      let timer;
      try {
        await assertWriter();
        timer = setInterval(() => {
          renewal = renewal.then(async () => {
            await assertWriter();
            await browserKv.set(key, lease());
            await assertWriter();
          }).catch(() => { lost = true; });
        }, leaseMs / 3);
        const writerKv = { ...browserKv, set: async (name, value) => {
          await assertWriter();
          await browserKv.set(name, value);
          await assertWriter();
        } };
        return await task(assertWriter, writerKv);
      } finally {
        clearInterval(timer);
        await renewal;
        if ((await browserKv.get(key))?.owner === owner) await browserKv.set(key, null);
      }
    };
    if (navigator.locks?.request) {
      return navigator.locks.request(`${PREFIX}writer`, { ifAvailable: true }, (lock) => {
        if (!lock) fail("另一窗口正在操作采集器");
        return run();
      });
    }
    return run();
  }
  function formatBrowserTotals(totals) {
    return `总 cost：${totals.totalCost} KB\n总 KB 收入：${totals.totalResult[0]} KB\n总 BBT 收入：${totals.totalResult[1]} BBT\n总抽奖次数：${totals.totalDraw}`;
  }
  function showBrowserStatus(message, totals = null) {
    if (browserUi) browserUi.status.textContent = message + (totals ? `\n${formatBrowserTotals(totals)}` : "");
  }
  function updateBrowserButtons() {
    if (!browserUi) return;
    browserUi.scan.disabled = browserBusy;
    browserUi.share.disabled = browserBusy || !(browserRepo?.state.baseline || browserRepo?.lastBundle);
    browserUi.share.title = browserRepo?.state.baseline ? "分享最近一次完整扫描的数据"
      : browserRepo?.lastBundle ? "重新下载上一有效分享包；本地进度仍需补全" : "首次扫描完成后才可分享";
  }
  function formatBrowserEta(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "估算中";
    const minutes = Math.ceil(ms / 60000);
    return minutes < 1 ? "不足 1 分钟" : minutes < 60 ? `约 ${minutes} 分钟` : `约 ${Math.ceil(minutes / 60)} 小时`;
  }
  async function scanBrowserLogs() {
    if (browserBusy) return;
    browserBusy = true;
    updateBrowserButtons();
    try {
      showBrowserStatus("正在打开积分日志……");
      if (!await openCreditLog()) return;
      await withBrowserWriter(async (assertWriter, writerKv) => {
        const identity = await createIdentity(writerKv);
        browserRepo = new Repository(writerKv, identity, assertWriter);
        await browserRepo.load(true);
        const result = await runScan(browserRepo, browserAdapter, ({ reads, etaMs, totals }) => {
          showBrowserStatus(`${browserRepo.notice ? `${browserRepo.notice}\n` : ""}已扫描部分：读取 ${reads} 页，预计剩余 ${formatBrowserEta(etaMs)}。`, totals);
        });
        showBrowserStatus(`完成：读取 ${result.reads} 页，本次新增 ${result.added} 次。`, browserRepo.baselineTotals());
      });
    } catch (error) {
      showBrowserStatus(`扫描暂停：${error.message}\n已成功保存的进度会在下次扫描时继续。`, browserRepo?.totals());
    } finally {
      browserBusy = false;
      updateBrowserButtons();
    }
  }
  function downloadBrowserBundle(bundle, suffix) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `shrine-${suffix}-${bundle.sequence}.json`;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
  }
  async function shareBrowserLogs() {
    if (browserBusy) return;
    browserBusy = true;
    updateBrowserButtons();
    try {
      await withBrowserWriter(async (assertWriter, writerKv) => {
        if (!await browserKv.get(`${PREFIX}identity`)) fail("首次扫描尚未完成，暂不能分享");
        const identity = await createIdentity(writerKv);
        browserRepo = new Repository(writerKv, identity, assertWriter);
        await browserRepo.load(false);
        if (!browserRepo.state.baseline && browserRepo.lastBundle) {
          const bundle = browserRepo.lastBundle;
          downloadBrowserBundle(bundle, (await digest(bundle.publicKey)).slice(0, 8));
          showBrowserStatus("本地进度需补全，已重新下载上一有效包。", bundle.lifetime);
          return;
        }
        const bundle = await browserRepo.prepareShare();
        downloadBrowserBundle(bundle, (await digest(bundle.publicKey)).slice(0, 8));
        showBrowserStatus(`已生成分享包：${bundle.events.length} 次事件。${browserRepo.state.job ? "未完成扫描的数据未包含在内。" : ""}`, browserRepo.baselineTotals());
      });
    } catch (error) {
      showBrowserStatus(`分享失败：${error.message}`);
    } finally {
      browserBusy = false;
      updateBrowserButtons();
    }
  }
  async function mountBrowserPanel() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      .panel{width:310px;max-width:calc(100vw - 56px);padding:12px;background:#fff;color:#1f2937;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 28px #0f172a2e;font:13px/1.5 Arial,sans-serif}
      header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:15px;margin:0}p{margin:7px 0}.note{color:#64748b;font-size:12px}
      button{border:1px solid #94a3b8;border-radius:5px;background:#f8fafc;color:#0f172a;padding:7px 8px;cursor:pointer}button:disabled{opacity:.6;cursor:default}
      .actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}#scan{background:#1d4ed8;color:white;border-color:#1d4ed8}#toggle{width:28px;height:28px;padding:0;font-size:18px}
      #status{padding:7px;background:#f1f5f9;border-radius:5px;white-space:pre-line;overflow-wrap:anywhere}.collapsed{width:auto;padding:0;border:0;background:transparent;box-shadow:none}.collapsed h2{display:none}
    </style><section class="panel"><header><h2>神社事件采集器</h2><button id="toggle" type="button" aria-controls="content">−</button></header>
      <div id="content"><p class="note">登录论坛后点击扫描，将自动打开积分日志。收入不扣奉纳，首次扫描完成后可分享。</p>
      <div class="actions"><button id="scan" type="button" disabled>扫描</button><button id="share" type="button" disabled>分享</button></div>
      <p id="status" role="status">正在读取本地进度……</p></div></section>`;
    const panel = shadow.querySelector(".panel");
    const content = shadow.getElementById("content");
    const toggle = shadow.getElementById("toggle");
    browserUi = { scan: shadow.getElementById("scan"), share: shadow.getElementById("share"), status: shadow.getElementById("status") };
    const collapse = (value) => {
      content.hidden = value;
      panel.classList.toggle("collapsed", value);
      toggle.textContent = value ? "+" : "−";
      toggle.title = value ? "展开" : "最小化";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(!value));
    };
    collapse(await browserKv.get(`${PREFIX}collapsed`, false) === true);
    toggle.addEventListener("click", () => {
      collapse(!content.hidden);
      void browserKv.set(`${PREFIX}collapsed`, content.hidden).catch(() => {});
    });
    browserUi.scan.addEventListener("click", scanBrowserLogs);
    browserUi.share.addEventListener("click", shareBrowserLogs);
  }
  async function startBrowser() {
    browserBusy = true;
    await mountBrowserPanel();
    updateBrowserButtons();
    try {
      if (await browserKv.get(`${PREFIX}identity`)) {
        browserRepo = new Repository(browserKv, await createIdentity(browserKv));
        await browserRepo.load(false);
        showBrowserStatus(browserRepo.notice || (browserRepo.state.job ? "已扫描部分：有未完成任务，点击扫描继续。"
          : browserRepo.state.baseline ? "上次完整扫描的生涯成绩：" : "尚未扫描。"), browserRepo.totals());
      } else showBrowserStatus("尚未扫描。首次完整扫描后可分享。");
    } catch (error) { showBrowserStatus(`本地数据无法读取：${error.message}`); }
    finally { browserBusy = false; updateBrowserButtons(); }
    if (location.pathname.replace(/\/$/, "") === CREDIT_PATH && location.hash === AUTO_SCAN_HASH) {
      history.replaceState(history.state, "", `${location.pathname}${location.search}`);
      void scanBrowserLogs();
    }
  }
  void startBrowser();
})();
