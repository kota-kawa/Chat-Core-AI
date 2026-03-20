type JsonRecord = Record<string, unknown>;

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4 || 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function arrayBufferToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function creationOptionsFromJson(raw: JsonRecord): CredentialCreationOptions {
  const publicKey = (raw.publicKey || raw) as JsonRecord;
  const user = (publicKey.user || {}) as JsonRecord;
  const excludeCredentials = Array.isArray(publicKey.excludeCredentials)
    ? publicKey.excludeCredentials.map((item) => {
        const descriptor = item as JsonRecord;
        return {
          ...descriptor,
          id: base64UrlToArrayBuffer(String(descriptor.id || "")),
          type: String(descriptor.type || "public-key") as PublicKeyCredentialType
        };
      })
    : undefined;

  return {
    publicKey: {
      ...publicKey,
      challenge: base64UrlToArrayBuffer(String(publicKey.challenge || "")),
      user: {
        id: base64UrlToArrayBuffer(String(user.id || "")),
        name: String(user.name || ""),
        displayName: String(user.displayName || user.name || "")
      },
      excludeCredentials
    } as PublicKeyCredentialCreationOptions
  };
}

function requestOptionsFromJson(raw: JsonRecord): CredentialRequestOptions {
  const publicKey = (raw.publicKey || raw) as JsonRecord;
  const allowCredentials = Array.isArray(publicKey.allowCredentials)
    ? publicKey.allowCredentials.map((item) => {
        const descriptor = item as JsonRecord;
        return {
          ...descriptor,
          id: base64UrlToArrayBuffer(String(descriptor.id || "")),
          type: String(descriptor.type || "public-key") as PublicKeyCredentialType
        };
      })
    : undefined;

  return {
    publicKey: {
      ...publicKey,
      challenge: base64UrlToArrayBuffer(String(publicKey.challenge || "")),
      allowCredentials
    } as PublicKeyCredentialRequestOptions
  };
}

function publicKeyCredentialToJson(credential: PublicKeyCredential): JsonRecord {
  const response = credential.response as AuthenticatorResponse & {
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
  };

  const payload: JsonRecord = {
    id: credential.id,
    rawId: arrayBufferToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON)
    }
  };

  const responsePayload = payload.response as JsonRecord;
  if (response.attestationObject) {
    responsePayload.attestationObject = arrayBufferToBase64Url(response.attestationObject);
  }
  if (typeof response.getTransports === "function") {
    responsePayload.transports = response.getTransports();
  }
  if (response.authenticatorData) {
    responsePayload.authenticatorData = arrayBufferToBase64Url(response.authenticatorData);
  }
  if (response.signature) {
    responsePayload.signature = arrayBufferToBase64Url(response.signature);
  }
  if (response.userHandle) {
    responsePayload.userHandle = arrayBufferToBase64Url(response.userHandle);
  }

  return payload;
}

async function readJsonResponse(response: Response): Promise<JsonRecord> {
  return (await response.json().catch(() => ({}))) as JsonRecord;
}

async function requestJson(url: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init
  });
  const payload = await readJsonResponse(response);
  if (!response.ok || payload.status === "fail") {
    throw new Error(String(payload.error || "認証に失敗しました。"));
  }
  return payload;
}

export function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

export async function authenticateWithPasskey(): Promise<JsonRecord> {
  if (!browserSupportsPasskeys()) {
    throw new Error("このブラウザではPasskeyを利用できません。");
  }

  const optionsPayload = await requestJson("/api/passkeys/authenticate/options", {
    method: "POST"
  });
  const requestOptions = requestOptionsFromJson(optionsPayload);
  const credential = await navigator.credentials.get(requestOptions);

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey認証がキャンセルされました。");
  }

  return requestJson("/api/passkeys/authenticate/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: publicKeyCredentialToJson(credential) })
  });
}

export async function registerPasskey(label?: string): Promise<JsonRecord> {
  if (!browserSupportsPasskeys()) {
    throw new Error("このブラウザではPasskeyを利用できません。");
  }

  const optionsPayload = await requestJson("/api/passkeys/register/options", {
    method: "POST"
  });
  const creationOptions = creationOptionsFromJson(optionsPayload);
  const credential = await navigator.credentials.create(creationOptions);

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey登録がキャンセルされました。");
  }

  return requestJson("/api/passkeys/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      credential: publicKeyCredentialToJson(credential),
      label: label || null
    })
  });
}
