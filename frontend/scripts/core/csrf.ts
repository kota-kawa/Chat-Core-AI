const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let csrfTokenPromise: Promise<string> | null = null;
let csrfProtectionInitialized = false;

const isSameOrigin = (target: string): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const url = new URL(target, window.location.origin);
    return url.origin === window.location.origin;
  } catch {
    return true;
  }
};

const getCsrfToken = async (originalFetch: typeof window.fetch): Promise<string> => {
  if (!csrfTokenPromise) {
    csrfTokenPromise = originalFetch("/api/csrf-token", {
      method: "GET",
      credentials: "same-origin"
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to fetch CSRF token");
        }
        const data = await response.json();
        return String(data.csrf_token || "");
      })
      .catch((error) => {
        csrfTokenPromise = null;
        throw error;
      });
  }

  return csrfTokenPromise;
};

const invalidateCsrfToken = (): void => {
  csrfTokenPromise = null;
};

const isCsrfFailureResponse = async (response: Response): Promise<boolean> => {
  if (response.status !== 403) return false;

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return false;
  }

  try {
    const payload = (await response.clone().json()) as { detail?: unknown };
    const detail = typeof payload?.detail === "string" ? payload.detail : "";
    return detail.startsWith("CSRF token");
  } catch {
    return false;
  }
};

const buildRequestWithCsrf = async (
  request: Request,
  originalFetch: typeof window.fetch,
  options: { forceRefreshToken?: boolean } = {}
): Promise<Request> => {
  const headers = new Headers(request.headers);
  if (options.forceRefreshToken) {
    invalidateCsrfToken();
  }

  if (!headers.has("X-CSRF-Token")) {
    const token = await getCsrfToken(originalFetch);
    if (token) {
      headers.set("X-CSRF-Token", token);
    }
  }

  return new Request(request, {
    headers,
    credentials: request.credentials || "same-origin"
  });
};

export function ensureCsrfProtection(): void {
  if (typeof window === "undefined" || csrfProtectionInitialized) {
    return;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const createBaseRequest = () => new Request(input, init);
    const baseRequest = createBaseRequest();
    const requestUrl = baseRequest.url;
    const method = baseRequest.method.toUpperCase();

    if (!UNSAFE_METHODS.has(method) || !isSameOrigin(requestUrl)) {
      return originalFetch(input, init);
    }

    let requestWithCsrf = await buildRequestWithCsrf(createBaseRequest(), originalFetch);
    let response = await originalFetch(requestWithCsrf);

    if (await isCsrfFailureResponse(response)) {
      requestWithCsrf = await buildRequestWithCsrf(createBaseRequest(), originalFetch, {
        forceRefreshToken: true
      });
      response = await originalFetch(requestWithCsrf);
    }

    return response;
  };

  csrfProtectionInitialized = true;
}

ensureCsrfProtection();

export {};
