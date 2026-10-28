const CATEGORY_LABELS = {
  'agent-error': 'Agent 执行错误',
  'prompt-rejected': '消息未被 DSH 接受',
  'security-intercept': '敏感信息安全拦截',
  'question-response': '提问回执失败',
  'approval-response': '审批回执失败'
};

export function createErrorRouter({ getConfig, sendToQQ, log, redact, isSensitive, now = Date.now }) {
  const recent = new Map();

  return async function routeError(sourceKey, category, detail) {
    const cfg = getConfig()?.errorRouting ?? {};
    if (cfg.enabled === false) return { sent: false, reason: 'disabled' };

    const targetQQ = String(cfg.targetQQ ?? '').trim();
    const targetKey = /^\d+$/.test(targetQQ) ? `private:${targetQQ}` : '';
    let summary = redact(String(detail ?? '').replace(/\s+/g, ' ').trim());
    if (!summary) summary = '未知错误';
    if (isSensitive(summary)) summary = '（错误详情含敏感信息，已隐藏）';
    summary = summary.slice(0, 500);

    const deduplicateMs = Math.max(0, Number(cfg.deduplicateMs) || 60000);
    const fingerprint = `${sourceKey}|${category}|${summary}`;
    const timestamp = now();
    const previous = recent.get(fingerprint) ?? 0;
    if (timestamp - previous < deduplicateMs) {
      log(`错误通知已去重 (${sourceKey}, ${category})`);
      return { sent: false, reason: 'deduplicated' };
    }
    recent.set(fingerprint, timestamp);
    if (recent.size > 500) {
      for (const [key, seenAt] of recent) {
        if (timestamp - seenAt >= deduplicateMs) recent.delete(key);
      }
    }

    let sent = false;
    if (targetKey) {
      const label = CATEGORY_LABELS[category] ?? category ?? 'Bridge 错误';
      await sendToQQ(targetKey, `⚠️ Bridge 错误通知\n类型：${label}\n来源：${sourceKey}\n摘要：${summary}`);
      sent = true;
    } else {
      log(`错误通知未发送：未配置有效的 errorRouting.targetQQ (${sourceKey}, ${category})`);
    }

    if (cfg.sourcePolicy === 'generic' && sourceKey && sourceKey !== targetKey) {
      await sendToQQ(sourceKey, '⚠️ 处理失败，请稍后重试。');
    }
    return { sent, targetKey: targetKey || null };
  };
}
