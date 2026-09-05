// ==UserScript==
// @name         神社记录采集器
// @namespace    shrine-event-study
// @version      1.0.3
// @description  只读扫描神社时运事件积分日志，生成匿名、增量、数字签名的数据包。
// @match        https://bbs.acgn.at/*
// @match        https://bbs2.kdays.net/*
// @match        https://b.schale.moe/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const PAGE_DELAY_MS = 600;
  const CREDIT_PATH = "/my/credit";
  const AUTO_SCAN_HASH = "#shrine-collector-scan";
  const BBT_EXCHANGE_KB = Object.freeze({ buy: 25, sell: 20 });
  const STORE = {
    privateKey: "shrine.privateKeyPkcs8.v1",
    publicKey: "shrine.publicKeySpki.v1",
    scanState: "shrine.scanState.v1",
    lastBundle: "shrine.lastBundle.v1",
    legacyExportState: "shrine.exportState.v4",
    panelCollapsed: "shrine.panelCollapsed.v1",
  };

  const SHRINE_RE = /神社\s*(?:时运|時運)?\s*事件/i;
  const SHRINE_COST_RE = /^神社\s*(?:时运|時運)?\s*事件\s*[:：]\s*cost\s*$/i;
  const TYPE_KB_RE = /坑币|坑幣/i;
  const TYPE_BBT_RE = /棒棒糖/i;

  let scanState = null;
  let busy = false;
  let statusElement;
  let panelHost = null;
  let actionButtons = [];

  function textOf(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function canonicalize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    const data = new Uint8Array(bytes);
    for (let i = 0; i < data.length; i += 0x8000) {
      binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function sha256Bytes(value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  }

  async function sha256Base64Url(value) {
    return bytesToBase64Url(await sha256Bytes(value));
  }

  async function getIdentity() {
    let privateKeyPkcs8 = GM_getValue(STORE.privateKey, "");
    let publicKeySpki = GM_getValue(STORE.publicKey, "");
    if (!privateKeyPkcs8 || !publicKeySpki) {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      privateKeyPkcs8 = bytesToBase64Url(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      publicKeySpki = bytesToBase64Url(await crypto.subtle.exportKey("spki", pair.publicKey));
      GM_setValue(STORE.privateKey, privateKeyPkcs8);
      GM_setValue(STORE.publicKey, publicKeySpki);
    }
    const publicDigest = await sha256Bytes(base64UrlToBytes(publicKeySpki));
    const contributorId = `shrine-${bytesToBase64Url(publicDigest.subarray(0, 18))}`;
    return { privateKeyPkcs8, publicKeySpki, contributorId };
  }

  async function signContent(privateKeyPkcs8, content) {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      base64UrlToBytes(privateKeyPkcs8),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(canonicalize(content)),
    );
    return bytesToBase64Url(signature);
  }

  async function verifyContentSignature(publicKeySpki, content, signature) {
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        base64UrlToBytes(publicKeySpki),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        base64UrlToBytes(signature),
        new TextEncoder().encode(canonicalize(content)),
      );
    } catch {
      return false;
    }
  }

  function parseSignedInteger(value, metric = null) {
    const compact = normalizeText(value).replace(/−/g, "-");
    const match = compact.match(/^([+-]?(?:\d+|\d{1,3}(?:,\d{3})+))\s*(KB|根)?$/i);
    if (!match) return null;
    const unit = match[2]?.toLowerCase() ?? null;
    if ((metric === "kb" && unit && unit !== "kb")
      || (metric === "bbt" && unit && unit !== "根")) return null;
    const number = Number.parseInt(match[1].replace(/,/g, ""), 10);
    return Number.isSafeInteger(number) ? number : null;
  }

  function parseShrineEventNumber(description) {
    const match = description.match(/神社\s*(?:时运|時運)?\s*事件\s*[:：]\s*(\d+)\s*$/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function parseLocalTimestamp(value) {
    const normalized = normalizeText(value);
    const match = normalized.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:\s*日)?\s+(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (!match) return null;
    const timestamp = `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")} ${String(match[4]).padStart(2, "0")}:${match[5]}`;
    const parsed = new Date(`${timestamp.replace(" ", "T")}:00Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 16).replace("T", " ") === timestamp
      ? timestamp
      : null;
  }

  function detectMetric(typeText) {
    if (TYPE_KB_RE.test(typeText)) return "kb";
    if (TYPE_BBT_RE.test(typeText)) return "bbt";
    return null;
  }

  function locateCreditTable(doc) {
    for (const table of doc.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      if (!rows.length) continue;
      for (let headerRowIndex = 0; headerRowIndex < Math.min(rows.length, 5); headerRowIndex++) {
        const headers = [...rows[headerRowIndex].querySelectorAll("th,td")].map(textOf);
        const lower = headers.map((x) => x.toLowerCase());
        const find = (...needles) => lower.findIndex((value) => needles.some((needle) => value.includes(needle)));
        const columns = {
          type: find("类型", "類型"),
          delta: find("变动", "變動", "变化", "變化"),
          description: find("说明", "說明", "描述"),
          time: find("时间", "時間"),
        };
        if (Object.values(columns).every((index) => index >= 0)) {
          return { table, rows, columns, headerRowIndex };
        }
      }
    }
    return null;
  }

  function fastHashText(value) {
    let hashA = 0x811c9dc5;
    let hashB = 0x9e3779b9;
    for (let index = 0; index <= value.length; index++) {
      const code = index < value.length ? value.charCodeAt(index) : 0x241e;
      hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
      hashB = Math.imul(hashB ^ code, 0x85ebca6b) >>> 0;
    }
    return `${hashA.toString(16)}:${hashB.toString(16)}`;
  }

  function extractPage(doc) {
    const found = locateCreditTable(doc);
    if (!found) throw new Error("没有找到积分日志表格；请确认已打开积分记录页面并等待加载完成。");
    const entries = [];
    for (let rowIndex = found.headerRowIndex + 1; rowIndex < found.rows.length; rowIndex++) {
      const cells = [...found.rows[rowIndex].querySelectorAll("th,td")];
      const maxIndex = Math.max(...Object.values(found.columns));
      if (cells.length <= maxIndex) continue;
      const description = textOf(cells[found.columns.description]);
      const timeText = textOf(cells[found.columns.time]);
      entries.push({
        token: fastHashText(textOf(found.rows[rowIndex])),
        time: parseLocalTimestamp(timeText),
        shrineRow: SHRINE_RE.test(description) ? {
          typeText: textOf(cells[found.columns.type]),
          deltaText: textOf(cells[found.columns.delta]),
          description,
          timeText,
        } : null,
      });
    }
    return entries;
  }

  function groupRowsByTime(rows) {
    const blocks = [];
    for (const row of rows) {
      const time = parseLocalTimestamp(row.timeText);
      const key = time === null ? `invalid:${normalizeText(row.timeText)}` : `time:${time}`;
      const current = blocks[blocks.length - 1];
      if (current && current.key === key) {
        current.rows.push(row);
      } else {
        blocks.push({ key, time, rows: [row] });
      }
    }
    return blocks;
  }

  function paginationState() {
    const found = locateCreditTable(document);
    const root = found?.table.closest("section.tab-panel")?.querySelector(".log-pagination .pagination");
    if (!root) return null;
    const pages = [...root.querySelectorAll(".pagination-main button")]
      .map((button) => ({ button, pageNumber: Number(textOf(button)) }))
      .filter((item) => Number.isSafeInteger(item.pageNumber) && item.pageNumber >= 1);
    const active = pages.find((item) => item.button.classList.contains("kd-btn--primary"));
    const jumpInput = root.querySelector("input.jump-input");
    const jumpButton = root.querySelector(".pagination-jumper button");
    return {
      activePage: active?.pageNumber ?? null,
      totalPages: pages.length ? Math.max(...pages.map((item) => item.pageNumber)) : null,
      pages,
      jumpInput,
      jumpButton,
    };
  }

  function currentTableSignature() {
    const found = locateCreditTable(document);
    if (!found) return null;
    const dataRows = found.rows.slice(found.headerRowIndex + 1);
    return `${dataRows.length}:${fastHashText(dataRows.map(textOf).join("\u241e"))}`;
  }

  function waitForPage(targetPage, previousSignature, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const signature = currentTableSignature();
        if (paginationState()?.activePage === targetPage
          && signature
          && signature !== previousSignature) finish();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const timer = setTimeout(() => finish(new Error("分页后表格没有在预期时间内更新")), timeoutMs);
      check();
    });
  }

  function waitForJumpButton(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, button) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(button);
      };
      const check = () => {
        const button = paginationState()?.jumpButton;
        if (button && !button.disabled) finish(null, button);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });
      const timer = setTimeout(() => finish(new Error("分页跳转按钮没有启用")), timeoutMs);
      check();
    });
  }

  async function jumpToPage(targetPage) {
    const state = paginationState();
    if (!state) {
      if (targetPage === 1) return;
      throw new Error("没有找到积分日志分页器");
    }
    if (state.activePage === targetPage) return;
    if (state.totalPages === null) {
      throw new Error("积分日志分页器结构不完整");
    }
    if (targetPage < 1 || targetPage > state.totalPages) {
      throw new Error(`无效页码：${targetPage}`);
    }

    const before = currentTableSignature();
    const directButton = state.pages.find((item) => item.pageNumber === targetPage)?.button;
    if (directButton && !directButton.disabled) {
      directButton.click();
      await waitForPage(targetPage, before);
      return;
    }
    if (!state.jumpInput || !state.jumpButton) throw new Error("积分日志跳页控件结构不完整");
    const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(state.jumpInput), "value")?.set;
    if (valueSetter) valueSetter.call(state.jumpInput, String(targetPage));
    else state.jumpInput.value = String(targetPage);
    state.jumpInput.dispatchEvent(new Event("input", { bubbles: true }));
    state.jumpInput.dispatchEvent(new Event("change", { bubbles: true }));
    const jumpButton = await waitForJumpButton();
    jumpButton.click();
    await waitForPage(targetPage, before);
  }

  function combineRows(allRows) {
    const relevant = allRows.filter((row) => SHRINE_RE.test(row.description));
    const recordsByKey = new Map();
    let invalidGroupCount = 0;
    for (const block of groupRowsByTime(relevant)) {
      const costRows = block.rows.filter((row) => SHRINE_COST_RE.test(row.description));
      if (!costRows.length) continue;
      const resultRows = block.rows.filter((row) => !SHRINE_COST_RE.test(row.description));
      const eventNumbers = resultRows.map((row) => parseShrineEventNumber(row.description));
      const distinctEventNumbers = new Set(eventNumbers.filter((value) => value !== null));
      const parsedResultRows = resultRows.map((row) => {
        const metric = detectMetric(row.typeText);
        return { metric, delta: parseSignedInteger(row.deltaText, metric) };
      });
      const kbValues = parsedResultRows.filter((row) => row.metric === "kb").map((row) => row.delta);
      const bbtValues = parsedResultRows.filter((row) => row.metric === "bbt").map((row) => row.delta);
      const costMetric = costRows.length === 1 ? detectMetric(costRows[0].typeText) : null;
      const costDelta = costRows.length === 1 ? parseSignedInteger(costRows[0].deltaText, costMetric) : null;
      const costKb = costMetric === "kb" && costDelta !== null && costDelta < 0 && Math.abs(costDelta) >= 1 && Math.abs(costDelta) <= 6
        ? Math.abs(costDelta)
        : null;
      const hasAnyResultRow = parsedResultRows.length > 0;
      const hasInvalidResultRow = parsedResultRows.some((row) => !row.metric || row.delta === null);
      const eventNumber = distinctEventNumbers.size === 1 ? [...distinctEventNumbers][0] : null;
      const time = block.time;
      if (costKb === null
        || eventNumber === null
        || eventNumbers.some((value) => value === null)
        || time === null
        || !hasAnyResultRow
        || hasInvalidResultRow) {
        invalidGroupCount++;
        continue;
      }
      const event = {
        eventNumber,
        costKb,
        resultVector: {
          kb: kbValues.reduce((sum, value) => sum + value, 0),
          bbt: bbtValues.reduce((sum, value) => sum + value, 0),
        },
        time,
      };
      const recordKey = canonicalize({ time, eventNumber: event.eventNumber, costKb });
      const existing = recordsByKey.get(recordKey);
      if (existing && canonicalize(existing) !== canonicalize(event)) {
        throw new Error("同一次抽奖出现了互相冲突的结果");
      }
      recordsByKey.set(recordKey, event);
    }
    if (invalidGroupCount) throw new Error(`发现 ${invalidGroupCount} 个无法可靠配对的神社事件；本次扫描未保存`);
    return [...recordsByKey.values()].sort((a, b) => a.time.localeCompare(b.time)
      || a.eventNumber - b.eventNumber
      || a.costKb - b.costKb);
  }

  function addLifetimeRows(base, rows) {
    const net = { kb: base.kb, bbt: base.bbt };
    let ignoredMetricRows = 0;
    for (const row of rows) {
      const metric = detectMetric(row.typeText);
      if (!metric) {
        ignoredMetricRows++;
        continue;
      }
      const delta = parseSignedInteger(row.deltaText, metric);
      if (delta === null) throw new Error("发现无法识别的神社积分变动；本次扫描未保存");
      net[metric] += delta;
      if (!Number.isSafeInteger(net[metric])) throw new Error("神社生涯净收入超出安全整数范围");
    }
    return { net, ignoredMetricRows };
  }

  function emptyModernStats() {
    return { count: 0, meanResultKb: 0, squaredDeviationSum: 0, totalResultKb: 0, totalCostKb: 0 };
  }

  function addModernNet(base, records) {
    const net = { ...base };
    for (const record of records) {
      net.kb += record.resultVector.kb - record.costKb;
      net.bbt += record.resultVector.bbt;
      if (!Number.isSafeInteger(net.kb) || !Number.isSafeInteger(net.bbt)) {
        throw new Error("新版神社净收入超出安全整数范围");
      }
    }
    return net;
  }

  function addRecordStats(base, records) {
    const stats = { ...base };
    for (const record of records) {
      const bbtValueKb = record.resultVector.bbt * BBT_EXCHANGE_KB.sell;
      const resultKb = record.resultVector.kb + bbtValueKb;
      if (!Number.isSafeInteger(resultKb) || !Number.isSafeInteger(record.costKb)) {
        throw new Error("新版事件统计超出安全整数范围");
      }
      stats.count++;
      stats.totalResultKb += resultKb;
      stats.totalCostKb += record.costKb;
      const delta = resultKb - stats.meanResultKb;
      stats.meanResultKb += delta / stats.count;
      stats.squaredDeviationSum += delta * (resultKb - stats.meanResultKb);
      if (!Number.isSafeInteger(stats.count)
        || !Number.isSafeInteger(stats.totalResultKb)
        || !Number.isSafeInteger(stats.totalCostKb)
        || !Number.isFinite(stats.meanResultKb)
        || !Number.isFinite(stats.squaredDeviationSum)) {
        throw new Error("新版事件累计统计超出安全范围");
      }
    }
    return stats;
  }

  function summarizeRecords(records) {
    const stats = addRecordStats(emptyModernStats(), records);
    if (!stats.count) return null;
    return {
      ...stats,
      sampleVarianceKb2: stats.count >= 2 ? stats.squaredDeviationSum / (stats.count - 1) : null,
      shrineNetIncomeKb: stats.totalResultKb - stats.totalCostKb,
    };
  }

  function formatStatistic(value) {
    const normalized = Math.abs(value) < 0.0005 ? 0 : value;
    return normalized.toFixed(3).replace(/\.?0+$/, "");
  }

  function formatScanSummary(pageCount, newEventCount, state, ignoredMetricRows) {
    const stats = state.modernStats;
    const sampleVariance = stats.count >= 2 ? stats.squaredDeviationSum / (stats.count - 1) : null;
    const lines = [
      `完成：读取 ${pageCount} 页，本次新增 ${newEventCount} 次。`,
      `新版神社结果样本均值：${stats.count ? `${formatStatistic(stats.meanResultKb)} KB` : "暂无样本"}`,
      `新版神社结果标准差：${sampleVariance !== null ? `${formatStatistic(Math.sqrt(sampleVariance))} KB` : "至少需要2次抽奖"}`,
      `新版神社净收入：${state.modernNet ? `${state.modernNet.kb} KB，${state.modernNet.bbt} BBT` : "待补全"}（${stats.count} 次抽奖）`,
      `生涯神社净收入：${state.lifetimeNet.kb} KB，${state.lifetimeNet.bbt} BBT（${state.lifetimeDrawCount === null ? "次数待补全" : `共 ${state.lifetimeDrawCount} 次抽奖`}）`,
    ];
    if (ignoredMetricRows) lines.push(`本次另有 ${ignoredMetricRows} 条其他积分类型的神社记录未计入净收入。`);
    return lines.join("\n");
  }

  function normalizeEventRecord(record) {
    const normalized = {
      eventNumber: record?.eventNumber,
      costKb: record?.costKb,
      resultVector: { kb: record?.resultVector?.kb, bbt: record?.resultVector?.bbt },
      time: record?.time,
    };
    if (!Number.isSafeInteger(normalized.eventNumber)
      || normalized.eventNumber < 0
      || !Number.isSafeInteger(normalized.costKb)
      || normalized.costKb < 1
      || normalized.costKb > 6
      || !Number.isSafeInteger(normalized.resultVector.kb)
      || !Number.isSafeInteger(normalized.resultVector.bbt)
      || parseLocalTimestamp(normalized.time) !== normalized.time) {
      throw new Error("扫描状态中存在无效事件");
    }
    return normalized;
  }

  function emptyScanState() {
    return {
      version: 1,
      coveredThrough: null,
      boundaryRowHashes: [],
      boundaryEvents: [],
      lifetimeNet: { kb: 0, bbt: 0 },
      lifetimeDrawCount: 0,
      modernNet: { kb: 0, bbt: 0 },
      modernStats: emptyModernStats(),
      pendingEvents: [],
      share: emptyShareState(),
    };
  }

  function emptyShareState() {
    return { lastSequence: 0, lastBundleHash: null, lastBundle: null };
  }

  function normalizeSavedBundle(bundle) {
    if (bundle === null) return null;
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
      throw new Error("本地上一数据包无效");
    }
    const normalized = {
      publicKey: bundle.publicKey,
      sequence: bundle.sequence,
      previousBundleHash: bundle.previousBundleHash,
      events: Array.isArray(bundle.events) ? bundle.events.map(normalizeEventRecord) : null,
      signature: bundle.signature,
      bundleHash: bundle.bundleHash,
    };
    if (typeof normalized.publicKey !== "string"
      || !Number.isSafeInteger(normalized.sequence)
      || normalized.sequence < 1
      || !(normalized.previousBundleHash === null
        || (typeof normalized.previousBundleHash === "string" && /^[A-Za-z0-9_-]{43}$/.test(normalized.previousBundleHash)))
      || (normalized.sequence === 1 && normalized.previousBundleHash !== null)
      || (normalized.sequence > 1 && normalized.previousBundleHash === null)
      || !normalized.events?.length
      || typeof normalized.signature !== "string"
      || !/^[A-Za-z0-9_-]+$/.test(normalized.signature)
      || typeof normalized.bundleHash !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(normalized.bundleHash)) {
      throw new Error("本地上一数据包无效");
    }
    return normalized;
  }

  function normalizeScanState(content) {
    if (!content || typeof content !== "object" || Array.isArray(content) || content.version !== 1) {
      throw new Error("本地扫描状态格式不受支持");
    }
    const coveredThrough = content.coveredThrough === null ? null : parseLocalTimestamp(content.coveredThrough);
    if (coveredThrough !== content.coveredThrough) throw new Error("本地扫描时间无效");
    const boundaryRowHashes = Array.isArray(content.boundaryRowHashes)
      ? [...content.boundaryRowHashes].sort() : null;
    if (!boundaryRowHashes
      || boundaryRowHashes.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))) {
      throw new Error("本地扫描边界无效");
    }
    if (coveredThrough === null && boundaryRowHashes.length) throw new Error("本地扫描边界与时间不一致");
    const boundaryEvents = Array.isArray(content.boundaryEvents ?? [])
      ? mergePendingEvents([], content.boundaryEvents ?? []) : null;
    if (!boundaryEvents
      || boundaryEvents.some((record) => record.time !== coveredThrough)) {
      throw new Error("本地扫描边界事件无效");
    }
    const lifetimeNet = {
      kb: content.lifetimeNet?.kb,
      bbt: content.lifetimeNet?.bbt,
    };
    if (!Number.isSafeInteger(lifetimeNet.kb) || !Number.isSafeInteger(lifetimeNet.bbt)) {
      throw new Error("本地生涯统计无效");
    }
    const modernNet = content.modernNet == null ? null : {
      kb: content.modernNet.kb,
      bbt: content.modernNet.bbt,
    };
    if (modernNet && (!Number.isSafeInteger(modernNet.kb) || !Number.isSafeInteger(modernNet.bbt))) {
      throw new Error("本地新版净收入无效");
    }
    const modernStats = {
      count: content.modernStats?.count,
      meanResultKb: content.modernStats?.meanResultKb,
      squaredDeviationSum: content.modernStats?.squaredDeviationSum,
      totalResultKb: content.modernStats?.totalResultKb,
      totalCostKb: content.modernStats?.totalCostKb,
    };
    if (!Number.isSafeInteger(modernStats.count)
      || modernStats.count < 0
      || !Number.isFinite(modernStats.meanResultKb)
      || !Number.isFinite(modernStats.squaredDeviationSum)
      || modernStats.squaredDeviationSum < -1e-9
      || !Number.isSafeInteger(modernStats.totalResultKb)
      || !Number.isSafeInteger(modernStats.totalCostKb)
      || modernStats.totalCostKb < 0
      || (modernStats.count === 0
        && (modernStats.meanResultKb !== 0
          || modernStats.squaredDeviationSum !== 0
          || modernStats.totalResultKb !== 0
          || modernStats.totalCostKb !== 0))
      || (modernStats.count > 0
        && (modernStats.totalCostKb < modernStats.count
          || modernStats.totalCostKb > modernStats.count * 6
          || Math.abs(modernStats.meanResultKb - modernStats.totalResultKb / modernStats.count)
            > 1e-9 * Math.max(1, Math.abs(modernStats.meanResultKb))))) {
      throw new Error("本地新版统计无效");
    }
    modernStats.squaredDeviationSum = Math.max(0, modernStats.squaredDeviationSum);
    // Pre-1.0.1 state has totals but no historical draw count; keep it for one-time backfill.
    const lifetimeDrawCount = content.lifetimeDrawCount ?? null;
    if (lifetimeDrawCount !== null
      && (!Number.isSafeInteger(lifetimeDrawCount) || lifetimeDrawCount < modernStats.count)) {
      throw new Error("本地生涯抽奖次数无效");
    }
    const pendingEvents = Array.isArray(content.pendingEvents)
      ? mergePendingEvents([], content.pendingEvents) : null;
    if (!pendingEvents) throw new Error("本地待分享记录无效");
    const rawShare = content.share ?? { lastSequence: 0, lastBundleHash: null, lastBundle: null };
    const lastSequence = rawShare.lastSequence;
    const lastBundleHash = rawShare.lastBundleHash;
    const lastBundle = normalizeSavedBundle(rawShare.lastBundle ?? null);
    if (!Number.isSafeInteger(lastSequence)
      || lastSequence < 0
      || !(lastBundleHash === null
        || (typeof lastBundleHash === "string" && /^[A-Za-z0-9_-]{43}$/.test(lastBundleHash)))
      || (lastSequence === 0 && (lastBundleHash !== null || lastBundle !== null))
      || (lastSequence > 0 && (!lastBundle
        || lastBundle.sequence !== lastSequence
        || lastBundle.bundleHash !== lastBundleHash))) {
      throw new Error("本地分享进度无效");
    }
    return {
      version: 1,
      coveredThrough,
      boundaryRowHashes,
      boundaryEvents,
      lifetimeNet,
      lifetimeDrawCount,
      modernNet,
      modernStats,
      pendingEvents,
      share: { lastSequence, lastBundleHash, lastBundle },
    };
  }

  async function validateSavedBundle(identity, share) {
    if (!share.lastBundle) return share.lastSequence === 0 && share.lastBundleHash === null;
    const bundle = share.lastBundle;
    if (bundle.publicKey !== identity.publicKeySpki) return false;
    const content = {
      publicKey: bundle.publicKey,
      sequence: bundle.sequence,
      previousBundleHash: bundle.previousBundleHash,
      events: bundle.events,
    };
    return await verifyContentSignature(bundle.publicKey, content, bundle.signature)
      && await sha256Base64Url(`${canonicalize(content)}.${bundle.signature}`) === bundle.bundleHash;
  }

  async function loadShareBackup(identity) {
    const candidates = [];
    const savedBundle = GM_getValue(STORE.lastBundle, "");
    if (savedBundle) {
      try {
        candidates.push(JSON.parse(savedBundle));
      } catch {
        // Ignore a malformed recovery copy.
      }
    }
    const legacy = GM_getValue(STORE.legacyExportState, "");
    if (legacy) {
      try {
        candidates.push(JSON.parse(legacy).lastBundle);
      } catch {
        // Ignore malformed state from a pre-1.0 version.
      }
    }
    for (const candidate of candidates) {
      try {
        const lastBundle = normalizeSavedBundle(candidate);
        if (!lastBundle) continue;
        const share = {
          lastSequence: lastBundle.sequence,
          lastBundleHash: lastBundle.bundleHash,
          lastBundle,
        };
        if (await validateSavedBundle(identity, share)) return share;
      } catch {
        // Try the next independently signed candidate.
      }
    }
    return emptyShareState();
  }

  async function loadScanState(identity) {
    const stored = GM_getValue(STORE.scanState, "");
    if (!stored) {
      const state = emptyScanState();
      state.share = await loadShareBackup(identity);
      return { state, restored: false, signatureInvalid: false };
    }
    try {
      const envelope = JSON.parse(stored);
      const valid = typeof envelope.signature === "string"
        && await verifyContentSignature(identity.publicKeySpki, envelope.content, envelope.signature);
      if (!valid) throw new Error("签名不匹配");
      const content = normalizeScanState(envelope.content);
      if (!await validateSavedBundle(identity, content.share)) throw new Error("分享链校验失败");
      return { state: content, restored: true, signatureInvalid: false };
    } catch (error) {
      console.warn("[神社研究] 本地扫描状态验签失败，将重新建立", error);
      const state = emptyScanState();
      state.share = await loadShareBackup(identity);
      return { state, restored: false, signatureInvalid: true };
    }
  }

  async function saveScanState(identity, content) {
    const normalized = normalizeScanState(content);
    if (!await validateSavedBundle(identity, normalized.share)) throw new Error("本地分享进度校验失败");
    const signature = await signContent(identity.privateKeyPkcs8, normalized);
    GM_setValue(STORE.scanState, JSON.stringify({ content: normalized, signature }));
    if (normalized.share.lastBundle) {
      GM_setValue(STORE.lastBundle, JSON.stringify(normalized.share.lastBundle));
    }
    scanState = normalized;
    return normalized;
  }

  function mergePendingEvents(existing, additions) {
    const records = new Map();
    for (const record of [...existing, ...additions]) {
      const normalized = normalizeEventRecord(record);
      const key = canonicalize({
        time: normalized.time,
        eventNumber: normalized.eventNumber,
        costKb: normalized.costKb,
      });
      const existingRecord = records.get(key);
      if (existingRecord && canonicalize(existingRecord) !== canonicalize(normalized)) {
        throw new Error("待分享记录中同一次抽奖存在冲突");
      }
      records.set(key, normalized);
    }
    return [...records.values()].sort((a, b) => a.time.localeCompare(b.time)
      || a.eventNumber - b.eventNumber
      || a.costKb - b.costKb);
  }

  function omitEventsInLastBundle(records, share) {
    if (!share.lastBundle) return records;
    const shared = new Map(share.lastBundle.events.map((record) => [
      canonicalize({ time: record.time, eventNumber: record.eventNumber, costKb: record.costKb }),
      canonicalize(record),
    ]));
    return records.filter((record) => {
      const key = canonicalize({ time: record.time, eventNumber: record.eventNumber, costKb: record.costKb });
      return shared.get(key) !== canonicalize(record);
    });
  }

  function appendPageEntries(target, pageEntries) {
    let overlap = Math.min(target.length, pageEntries.length);
    while (overlap > 0) {
      let matches = true;
      for (let index = 0; index < overlap; index++) {
        if (target[target.length - overlap + index].token !== pageEntries[index].token) {
          matches = false;
          break;
        }
      }
      if (matches) break;
      overlap--;
    }
    target.push(...pageEntries.slice(overlap));
    return pageEntries.length - overlap;
  }

  async function hashShrineRow(row) {
    const metric = detectMetric(row.typeText);
    const delta = metric ? parseSignedInteger(row.deltaText, metric) : null;
    const eventNumber = parseShrineEventNumber(row.description);
    return sha256Base64Url(canonicalize({
      type: metric ?? normalizeText(row.typeText),
      delta: delta ?? normalizeText(row.deltaText),
      description: SHRINE_COST_RE.test(row.description)
        ? "cost"
        : eventNumber ?? normalizeText(row.description),
      time: parseLocalTimestamp(row.timeText) ?? normalizeText(row.timeText),
    }));
  }

  async function buildScanUpdate(previous, mergedEntries, scanUpperBound) {
    const windowEntries = mergedEntries.filter((entry) => {
      if (!entry.shrineRow) return false;
      if (scanUpperBound && entry.time && entry.time > scanUpperBound) return false;
      if (previous.coveredThrough && entry.time && entry.time < previous.coveredThrough) return false;
      if (previous.coveredThrough && !entry.time) throw new Error("增量扫描遇到无法解析时间的神社记录");
      return true;
    });
    const hashedRows = await Promise.all(windowEntries.map(async (entry) => ({
      ...entry,
      rowHash: await hashShrineRow(entry.shrineRow),
    })));
    const previousBoundaryCounts = new Map();
    for (const hash of previous.boundaryRowHashes) {
      previousBoundaryCounts.set(hash, (previousBoundaryCounts.get(hash) ?? 0) + 1);
    }
    const newRows = hashedRows.filter((entry) => {
      if (!previous.coveredThrough || entry.time > previous.coveredThrough) return true;
      if (entry.time !== previous.coveredThrough) return false;
      const unseenCopies = previousBoundaryCounts.get(entry.rowHash) ?? 0;
      if (!unseenCopies) return true;
      previousBoundaryCounts.set(entry.rowHash, unseenCopies - 1);
      return false;
    });
    const parsedRecords = combineRows(hashedRows.map((entry) => entry.shrineRow));
    const previousBoundaryEvents = new Map(previous.boundaryEvents.map((record) => [
      canonicalize({ time: record.time, eventNumber: record.eventNumber, costKb: record.costKb }),
      record,
    ]));
    const seenPreviousBoundaryEvents = new Set();
    const newRecords = parsedRecords.filter((record) => {
      if (!previous.coveredThrough || record.time > previous.coveredThrough) return true;
      if (record.time !== previous.coveredThrough) return false;
      const key = canonicalize({ time: record.time, eventNumber: record.eventNumber, costKb: record.costKb });
      const existing = previousBoundaryEvents.get(key);
      if (!existing) return true;
      seenPreviousBoundaryEvents.add(key);
      if (canonicalize(existing) !== canonicalize(record)) {
        throw new Error("已统计的边界事件内容发生变化；本次扫描未保存");
      }
      return false;
    });
    if (seenPreviousBoundaryEvents.size !== previousBoundaryEvents.size) {
      throw new Error("已统计的边界事件从日志中消失；本次扫描未保存");
    }
    const lifetimeUpdate = addLifetimeRows(previous.lifetimeNet, newRows.map((entry) => entry.shrineRow));
    const lifetimeDrawCount = countLifetimeDraws(previous, mergedEntries, scanUpperBound);
    // Old state only retained converted results; recover the two currencies once from full history.
    const modernNet = previous.modernNet === null
      ? addModernNet({ kb: 0, bbt: 0 }, combineRows(mergedEntries
        .filter((entry) => entry.shrineRow && (!scanUpperBound || entry.time <= scanUpperBound))
        .map((entry) => entry.shrineRow)))
      : addModernNet(previous.modernNet, newRecords);
    const coveredThrough = !previous.coveredThrough || (scanUpperBound && scanUpperBound > previous.coveredThrough)
      ? scanUpperBound : previous.coveredThrough;
    const boundaryHashes = [];
    for (const entry of hashedRows) {
      if (entry.time === coveredThrough) boundaryHashes.push(entry.rowHash);
    }
    const boundaryEvents = parsedRecords.filter((record) => record.time === coveredThrough);
    const pendingAdditions = omitEventsInLastBundle(newRecords, previous.share);
    return {
      state: {
        version: 1,
        coveredThrough,
        boundaryRowHashes: boundaryHashes.sort(),
        boundaryEvents,
        lifetimeNet: lifetimeUpdate.net,
        lifetimeDrawCount,
        modernNet,
        modernStats: addRecordStats(previous.modernStats, newRecords),
        pendingEvents: mergePendingEvents(previous.pendingEvents, pendingAdditions),
        share: previous.share,
      },
      newEventCount: newRecords.length,
      ignoredMetricRows: lifetimeUpdate.ignoredMetricRows,
    };
  }

  function countLifetimeDraws(previous, entries, scanUpperBound) {
    const backfill = previous.lifetimeDrawCount === null;
    const times = new Set();
    for (const entry of entries) {
      if (!entry.shrineRow || (scanUpperBound && entry.time > scanUpperBound)) continue;
      if (!entry.time) throw new Error("无法根据日志时间统计生涯抽奖次数");
      if (!backfill && previous.coveredThrough
        && (entry.time < previous.coveredThrough
          || (entry.time === previous.coveredThrough && previous.boundaryRowHashes.length))) continue;
      times.add(entry.time);
    }
    return (backfill ? 0 : previous.lifetimeDrawCount) + times.size;
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function createSignedBundle(identity, share, records) {
    const events = records.map(normalizeEventRecord);
    if (!events.length) throw new Error("没有待分享的新版记录。");
    const content = {
      publicKey: identity.publicKeySpki,
      sequence: share.lastSequence + 1,
      previousBundleHash: share.lastBundleHash,
      events,
    };
    const signature = await signContent(identity.privateKeyPkcs8, content);
    const bundleHash = await sha256Base64Url(`${canonicalize(content)}.${signature}`);
    return { ...content, signature, bundleHash };
  }

  async function openCreditLog() {
    if (location.pathname.replace(/\/$/, "") !== CREDIT_PATH) {
      // Carry this click across the navigation without storing a scan request.
      location.assign(`${location.origin}${CREDIT_PATH}${AUTO_SCAN_HASH}`);
      return false;
    }
    setStatus("正在打开积分日志……");
    await new Promise((resolve, reject) => {
      let clickedTab = null;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (settled) return;
        try {
          if (location.pathname.replace(/\/$/, "") !== CREDIT_PATH) {
            finish(new Error("页面已离开积分页；请登录论坛后重新点击扫描"));
            return;
          }
          const tab = [...document.querySelectorAll('button[role="tab"]')]
            .find((button) => textOf(button) === "积分日志");
          if (tab?.getAttribute("aria-selected") === "true" && locateCreditTable(document)) {
            finish();
          } else if (tab && !tab.disabled && tab !== clickedTab
            && tab.getAttribute("aria-selected") !== "true") {
            clickedTab = tab;
            tab.click();
          }
        } catch (error) {
          finish(error);
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["aria-selected", "disabled"],
      });
      const timer = setTimeout(() => finish(new Error("积分日志未能在20秒内打开；请确认已登录后重试")), 20000);
      check();
    });
    return true;
  }

  function resumeRequestedScan() {
    if (location.pathname.replace(/\/$/, "") !== CREDIT_PATH || location.hash !== AUTO_SCAN_HASH) return;
    // Consume the one-off request before scanning; a later refresh must not restart it.
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    void scanCreditLog();
  }

  async function scanCreditLog() {
    if (busy) return;
    setBusy(true);
    setStatus("正在打开积分日志……");
    let originalPage = 1;
    let logOpened = false;
    try {
      if (!await openCreditLog()) return;
      logOpened = true;
      setStatus("正在校验本地进度……");
      const identity = await getIdentity();
      const loaded = await loadScanState(identity);
      const previous = loaded.state;
      scanState = previous;
      const initialPagination = paginationState();
      if (initialPagination
        && (!initialPagination.activePage
          || !initialPagination.totalPages
          || !initialPagination.pages.length)) {
        throw new Error("积分日志分页器结构不完整");
      }
      originalPage = initialPagination?.activePage ?? 1;
      let knownTotalPages = initialPagination?.totalPages ?? 1;
      const mergedEntries = [];
      const startedAt = Date.now();
      let pagesRead = 0;
      let scanUpperBound = null;
      let cursorTime = null;
      let coverageReached = false;

      for (let targetPage = 1; targetPage <= knownTotalPages; targetPage++) {
        await jumpToPage(targetPage);
        if (!currentTableSignature()) throw new Error("当前页面没有找到 .log-table 积分表格");
        const activePage = paginationState()?.activePage ?? 1;
        if (activePage !== targetPage) throw new Error(`请求第 ${targetPage} 页后，页面停留在第 ${activePage} 页`);
        const pageEntries = extractPage(document);
        if (targetPage === 1 && !pageEntries.length) {
          throw new Error("积分日志表格尚无可读记录；请等待页面加载完成后重试");
        }
        if (pageEntries.some((entry) => entry.time === null)) {
          throw new Error("积分日志出现无法识别的时间；本次扫描未保存");
        }
        for (let index = 1; index < pageEntries.length; index++) {
          if (pageEntries[index].time > pageEntries[index - 1].time) {
            throw new Error("积分日志不是按时间倒序排列；本次扫描未保存");
          }
        }
        if (targetPage === 1) {
          const times = pageEntries.map((entry) => entry.time).filter(Boolean);
          scanUpperBound = times.length ? times.reduce((latest, time) => time > latest ? time : latest) : null;
        }
        const boundedEntries = scanUpperBound
          ? pageEntries.filter((entry) => entry.time <= scanUpperBound)
          : pageEntries;
        appendPageEntries(mergedEntries, boundedEntries);
        pagesRead++;
        const boundedTimes = pageEntries
          .map((entry) => entry.time)
          .filter((time) => time && (!scanUpperBound || time <= scanUpperBound));
        if (boundedTimes.length) {
          const oldestOnPage = boundedTimes.reduce((oldest, time) => time < oldest ? time : oldest);
          cursorTime = cursorTime === null || oldestOnPage < cursorTime ? oldestOnPage : cursorTime;
          if (previous.lifetimeDrawCount !== null && previous.modernNet !== null
            && previous.coveredThrough && oldestOnPage < previous.coveredThrough) coverageReached = true;
        }
        const currentTotalPages = paginationState()?.totalPages ?? knownTotalPages;
        knownTotalPages = currentTotalPages;
        const averagePageMs = (Date.now() - startedAt) / pagesRead + PAGE_DELAY_MS;
        const remainingPages = coverageReached ? 0 : Math.max(0, knownTotalPages - targetPage);
        const eta = remainingPages ? `，预计最多还需 ${formatDuration(averagePageMs * remainingPages)}` : "";
        const restoredNote = loaded.signatureInvalid ? "；旧进度签名无效，正在重建"
          : previous.lifetimeDrawCount === null || previous.modernNet === null
            ? "；正在补全次数与分币种净收入（仅此次）" : "";
        setStatus(`已读取 ${pagesRead} 页，当前到 ${cursorTime ?? "未知时间"}${eta}${restoredNote}……`);
        if (coverageReached || targetPage >= knownTotalPages) break;
        await sleep(PAGE_DELAY_MS);
      }

      const update = await buildScanUpdate(previous, mergedEntries, scanUpperBound);
      const saved = await saveScanState(identity, update.state);
      const rebuilt = loaded.signatureInvalid ? "旧进度验签失败，已重新全量建立。\n" : "";
      setStatus(`${rebuilt}${formatScanSummary(pagesRead, update.newEventCount, saved, update.ignoredMetricRows)}`);
    } catch (error) {
      console.error("[神社研究] 扫描失败", error);
      setStatus(`扫描失败：${error.message}`);
    } finally {
      if (logOpened && (paginationState()?.activePage ?? 1) !== originalPage) {
        try {
          await jumpToPage(originalPage);
        } catch (error) {
          console.warn("[神社研究] 无法恢复原页", error);
        }
      }
      setBusy(false);
    }
  }

  async function shareIncrementalBundle() {
    if (busy) return;
    setBusy(true);
    try {
      const identity = await getIdentity();
      if (!scanState) {
        const loaded = await loadScanState(identity);
        if (!loaded.restored) throw new Error("请先扫描积分日志。");
        scanState = loaded.state;
      }
      if (!scanState.pendingEvents.length) {
        if (!scanState.share.lastBundle) throw new Error("没有待分享的新版记录。");
        downloadJson(
          scanState.share.lastBundle,
          `shrine-${identity.contributorId.slice(-8)}-${scanState.share.lastSequence}.json`,
        );
        setStatus("没有新增记录；已重新下载上一数据包。");
        return;
      }

      const bundle = await createSignedBundle(identity, scanState.share, scanState.pendingEvents);
      const fileName = `shrine-${identity.contributorId.slice(-8)}-${bundle.sequence}.json`;
      await saveScanState(identity, {
        ...scanState,
        pendingEvents: [],
        share: { lastSequence: bundle.sequence, lastBundleHash: bundle.bundleHash, lastBundle: bundle },
      });
      downloadJson(bundle, fileName);
      setStatus(`已分享 ${bundle.events.length} 条新增记录。匿名贡献者：${identity.contributorId}`);
    } catch (error) {
      console.error("[神社研究] 分享失败", error);
      setStatus(`分享失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function downloadJson(value, fileName) {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function setStatus(message) {
    if (statusElement) statusElement.textContent = message;
  }

  function setBusy(value) {
    busy = value;
    for (const button of actionButtons) button.disabled = value;
  }

  function addPanel() {
    if (panelHost) return;
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.right = "16px";
    host.style.bottom = "16px";
    host.style.zIndex = "2147483647";
    document.documentElement.appendChild(host);
    panelHost = host;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .panel { width: 310px; font: 13px/1.45 Arial, sans-serif; color: #1f2937; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 8px 28px rgba(15,23,42,.18); padding: 12px; }
        .panel.collapsed { width: auto; padding: 0; border: 0; background: transparent; box-shadow: none; }
        .panel.collapsed h2 { display: none; }
        .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        h2 { font-size: 15px; margin: 0; }
        p { margin: 6px 0; }
        .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0; }
        button { border: 1px solid #94a3b8; border-radius: 5px; background: #f8fafc; color: #0f172a; padding: 7px 8px; cursor: pointer; }
        button.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
        button:disabled { cursor: wait; opacity: .6; }
        .toggle { width: 28px; height: 28px; padding: 0; flex: none; font-size: 18px; }
        .status { min-height: 38px; padding: 7px; background: #f1f5f9; border-radius: 5px; overflow-wrap: anywhere; white-space: pre-line; }
        .note { color: #64748b; font-size: 12px; }
      </style>
      <section class="panel">
        <div class="panel-header">
          <h2>神社事件采集器</h2>
          <button id="toggle" class="toggle" type="button" title="最小化" aria-label="最小化" aria-expanded="true" aria-controls="panel-content">−</button>
        </div>
        <div id="panel-content">
          <p class="note">登录论坛后点击扫描，将自动打开积分日志。</p>
          <div class="buttons">
            <button id="scan" class="primary">扫描</button>
            <button id="share">分享</button>
          </div>
          <p id="status" class="status" title="均值和标准差按1 BBT=20 KB折算；标准差按样本公式计算。净收入按KB、BBT分别求和，奉纳从KB扣除。生涯次数按日志的不同分钟统计，同次抽奖的多行合计一次。">尚未扫描。</p>
        </div>
      </section>`;
    statusElement = shadow.getElementById("status");
    actionButtons = [...shadow.querySelectorAll(".buttons button")];
    const toggle = shadow.getElementById("toggle");
    const content = shadow.getElementById("panel-content");
    const panel = shadow.querySelector(".panel");
    const setCollapsed = (collapsed) => {
      content.hidden = collapsed;
      panel.classList.toggle("collapsed", collapsed);
      toggle.textContent = collapsed ? "+" : "−";
      toggle.title = collapsed ? "展开" : "最小化";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(!collapsed));
    };
    setCollapsed(GM_getValue(STORE.panelCollapsed, false) === true);
    toggle.addEventListener("click", () => {
      setCollapsed(!content.hidden);
      GM_setValue(STORE.panelCollapsed, content.hidden);
    });
    shadow.getElementById("scan").addEventListener("click", scanCreditLog);
    shadow.getElementById("share").addEventListener("click", shareIncrementalBundle);
  }

  addPanel();
  resumeRequestedScan();
})();
