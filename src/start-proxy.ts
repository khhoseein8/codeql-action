import * as core from "@actions/core";

import { parseLanguage, Language } from "./languages";
import { Logger } from "./logging";
import { ConfigurationError } from "./util";

export type Credential = {
  type: string;
  host?: string;
  url?: string;
  username?: string;
  password?: string;
  token?: string;
};

const LANGUAGE_TO_REGISTRY_TYPE: Record<Language, string> = {
  java: "maven_repository",
  csharp: "nuget_feed",
  javascript: "npm_registry",
  python: "python_index",
  ruby: "rubygems_server",
  rust: "cargo_registry",
  go: "goproxy_server",
  // We do not have an established proxy type for these languages, thus leaving empty.
  actions: "",
  cpp: "",
  swift: "",
} as const;

/**
 * Checks that `value` is neither `undefined` nor `null`.
 * @param value The value to test.
 * @returns Narrows the type of `value` to exclude `undefined` and `null`.
 */
function isDefined<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/**
 * In some cases, the backend will provide `e.password` even if it is actually a token.
 * However, `e.username` will be undefined if `e.password` is actually a token.
 * @param e The credential to return the token or password for.
 * @returns A partial `Credential` object that includes the appropriate token or password.
 */
function getTokenOrPassword(e: Credential): Partial<Credential> {
  // If we have a token already, then the password isn't it.
  if (isDefined(e.token)) return { token: e.token };
  // If `username` is undefined, then the password is a token.
  if (e.username === undefined) return { token: e.password };
  // Otherwise, if `username` is defined, then the password is a password.
  return { password: e.password };
}

// getCredentials returns registry credentials from action inputs.
// It prefers `registries_credentials` over `registry_secrets`.
// If neither is set, it returns an empty array.
export function getCredentials(
  logger: Logger,
  registrySecrets: string | undefined,
  registriesCredentials: string | undefined,
  languageString: string | undefined,
): Credential[] {
  const language = languageString ? parseLanguage(languageString) : undefined;
  const registryTypeForLanguage = language
    ? LANGUAGE_TO_REGISTRY_TYPE[language]
    : undefined;

  let credentialsStr: string;
  if (registriesCredentials !== undefined) {
    logger.info(`Using registries_credentials input.`);
    credentialsStr = Buffer.from(registriesCredentials, "base64").toString();
  } else if (registrySecrets !== undefined) {
    logger.info(`Using registry_secrets input.`);
    credentialsStr = registrySecrets;
  } else {
    logger.info(`No credentials defined.`);
    return [];
  }

  // Parse and validate the credentials
  let parsed: Credential[];
  try {
    parsed = JSON.parse(credentialsStr) as Credential[];
  } catch {
    // Don't log the error since it might contain sensitive information.
    logger.error("Failed to parse the credentials data.");
    throw new ConfigurationError("Invalid credentials format.");
  }

  // Check that the parsed data is indeed an array.
  if (!Array.isArray(parsed)) {
    throw new ConfigurationError(
      "Expected credentials data to be an array of configurations, but it is not.",
    );
  }

  const out: Credential[] = [];
  for (const e of parsed) {
    if (e === null || typeof e !== "object") {
      throw new ConfigurationError("Invalid credentials - must be an object");
    }

    // Mask credentials to reduce chance of accidental leakage in logs.
    if (isDefined(e.password)) {
      core.setSecret(e.password);
    }
    if (isDefined(e.token)) {
      core.setSecret(e.token);
    }

    if (!isDefined(e.url) && !isDefined(e.host)) {
      // The proxy needs one of these to work. If both are defined, the url has the precedence.
      throw new ConfigurationError(
        "Invalid credentials - must specify host or url",
      );
    }

    // Filter credentials based on language if specified. `type` is the registry type.
    // E.g., "maven_feed" for Java/Kotlin, "nuget_repository" for C#.
    if (registryTypeForLanguage && e.type !== registryTypeForLanguage) {
      continue;
    }

    const isPrintable = (str: string | undefined): boolean => {
      return str ? /^[\x20-\x7E]*$/.test(str) : true;
    };

    if (
      !isPrintable(e.type) ||
      !isPrintable(e.host) ||
      !isPrintable(e.url) ||
      !isPrintable(e.username) ||
      !isPrintable(e.password) ||
      !isPrintable(e.token)
    ) {
      throw new ConfigurationError(
        "Invalid credentials - fields must contain only printable characters",
      );
    }

    out.push({
      type: e.type,
      host: e.host,
      url: e.url,
      username: e.username,
      ...getTokenOrPassword(e),
    });
  }
  return out;
}
