export type ContributionDraftLicence = "CC0-1.0" | "CC-BY-4.0";
export type ContributionDraftMode = "single" | "batch";

export interface PersistedContributionRecording {
  id?: string;
  wordId: string;
  blob: Blob;
  mimeType: string;
  recordedAt: string;
}

export interface PersistedContributionDraft {
  schemaVersion: 1;
  id: string;
  mode: ContributionDraftMode;
  languageId: string;
  wordId?: string;
  licence: ContributionDraftLicence;
  speakerName: string;
  accent: string;
  keptRecordings: PersistedContributionRecording[];
  currentRecording?: PersistedContributionRecording;
  skippedWordIds: string[];
  updatedAt: string;
}

const CONTRIBUTION_DRAFT_DB_NAME = "vowel-trowel-contribution-drafts";
const CONTRIBUTION_DRAFT_DB_VERSION = 1;
const CONTRIBUTION_DRAFT_STORE_NAME = "drafts";

export function contributionSingleDraftId(languageId: string, wordId: string): string {
  return `${languageId}:single:${wordId}`;
}

export function contributionBatchDraftId(languageId: string): string {
  return `${languageId}:batch`;
}

export async function loadContributionDraft(id: string): Promise<PersistedContributionDraft | null> {
  const value = await readContributionDraftStore(id, "readonly", (store) => requestToPromise(store.get(id)));

  return normalizeContributionDraft(value, id);
}

export async function saveContributionDraft(draft: PersistedContributionDraft): Promise<void> {
  await readContributionDraftStore(draft.id, "readwrite", async (store) => {
    await requestToPromise(store.put({
      ...draft,
      updatedAt: new Date().toISOString(),
    }));
  });
}

export async function deleteContributionDraft(id: string): Promise<void> {
  await readContributionDraftStore(id, "readwrite", async (store) => {
    await requestToPromise(store.delete(id));
  });
}

async function readContributionDraftStore<T>(
  id: string,
  mode: IDBTransactionMode,
  read: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openContributionDraftDb();

  try {
    const transaction = db.transaction(CONTRIBUTION_DRAFT_STORE_NAME, mode);
    const store = transaction.objectStore(CONTRIBUTION_DRAFT_STORE_NAME);
    const transactionDone = transactionToPromise(transaction);
    const value = await read(store);

    await transactionDone;
    return value;
  } catch (error) {
    throw new Error(`Could not access contribution draft ${id}.`, { cause: error });
  } finally {
    db.close();
  }
}

function openContributionDraftDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CONTRIBUTION_DRAFT_DB_NAME, CONTRIBUTION_DRAFT_DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(CONTRIBUTION_DRAFT_STORE_NAME)) {
        db.createObjectStore(CONTRIBUTION_DRAFT_STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Could not open contribution draft storage.")));
    request.addEventListener("blocked", () => reject(new Error("Contribution draft storage is blocked by another open tab.")));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")));
  });
}

function normalizeContributionDraft(value: unknown, expectedId: string): PersistedContributionDraft | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.id !== expectedId) {
    return null;
  }

  if (value.mode !== "single" && value.mode !== "batch") {
    return null;
  }

  if (typeof value.languageId !== "string" || !isContributionDraftLicence(value.licence)) {
    return null;
  }

  const keptRecordings = Array.isArray(value.keptRecordings)
    ? value.keptRecordings.map(normalizeContributionRecording).filter(isPersistedContributionRecording)
    : [];
  const currentRecording = normalizeContributionRecording(value.currentRecording);

  return {
    schemaVersion: 1,
    id: expectedId,
    mode: value.mode,
    languageId: value.languageId,
    wordId: typeof value.wordId === "string" ? value.wordId : undefined,
    licence: value.licence,
    speakerName: typeof value.speakerName === "string" ? value.speakerName : "",
    accent: typeof value.accent === "string" ? value.accent : "",
    keptRecordings,
    currentRecording: isPersistedContributionRecording(currentRecording) ? currentRecording : undefined,
    skippedWordIds: Array.isArray(value.skippedWordIds)
      ? [...new Set(value.skippedWordIds.filter((wordId): wordId is string => typeof wordId === "string" && wordId.length > 0))]
      : [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

function normalizeContributionRecording(value: unknown): PersistedContributionRecording | null {
  if (!isRecord(value) || typeof Blob === "undefined" || !(value.blob instanceof Blob)) {
    return null;
  }

  if (typeof value.wordId !== "string" || value.wordId.length === 0) {
    return null;
  }

  return {
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : undefined,
    wordId: value.wordId,
    blob: value.blob,
    mimeType: typeof value.mimeType === "string" && value.mimeType.length > 0 ? value.mimeType : value.blob.type || "audio/webm",
    recordedAt: typeof value.recordedAt === "string" && value.recordedAt.length > 0 ? value.recordedAt : new Date().toISOString(),
  };
}

function isPersistedContributionRecording(value: PersistedContributionRecording | null): value is PersistedContributionRecording {
  return value !== null;
}

function isContributionDraftLicence(value: unknown): value is ContributionDraftLicence {
  return value === "CC0-1.0" || value === "CC-BY-4.0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
