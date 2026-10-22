const state = {
  externalCallCount: 0,
};

function hashEmail(email) {
  if (!email) return 0;
  const str = String(email).toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100;
}

function resetExternalCallCount() {
  state.externalCallCount = 0;
}

function getExternalCallCount() {
  return state.externalCallCount;
}

async function enrichSingleLead(email) {
  state.externalCallCount++;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    email,
    score: hashEmail(email),
  };
}

async function enrichLeadBatch(emails, chunkSize = 10, concurrency = 5) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return [];
  }

  const chunks = [];
  for (let i = 0; i < emails.length; i += chunkSize) {
    chunks.push(emails.slice(i, i + chunkSize));
  }

  const results = [];
  let chunkIdx = 0;

  async function worker() {
    while (chunkIdx < chunks.length) {
      const currentChunk = chunks[chunkIdx++];
      state.externalCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      for (const email of currentChunk) {
        results.push({
          email,
          score: hashEmail(email),
        });
      }
    }
  }

  const activeWorkers = Array.from(
    { length: Math.min(concurrency, chunks.length) },
    () => worker()
  );

  await Promise.all(activeWorkers);
  return results;
}

module.exports = {
  get externalCallCount() {
    return state.externalCallCount;
  },
  set externalCallCount(val) {
    state.externalCallCount = val;
  },
  resetExternalCallCount,
  getExternalCallCount,
  enrichSingleLead,
  enrichLeadBatch,
  hashEmail,
};
