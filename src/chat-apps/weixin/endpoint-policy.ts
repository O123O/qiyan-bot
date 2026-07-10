export type WeixinEndpointKind =
  | "qr-create"
  | "qr-status"
  | "get-updates"
  | "get-upload-url"
  | "send-message"
  | "get-config"
  | "send-typing"
  | "notify-start"
  | "notify-stop"
  | "cdn-download"
  | "cdn-upload";

const DEFAULT_MAX_REDIRECTS = 3;

export function validateTencentUrl(value: string | URL, kind: WeixinEndpointKind): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new TypeError("WeChat endpoint is not trusted");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || (url.port !== "" && url.port !== "443")
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || (hostname !== "weixin.qq.com" && !hostname.endsWith(".weixin.qq.com"))
  ) throw new TypeError("WeChat endpoint is not trusted");

  if (/%(?:2f|5c|2e)/iu.test(url.pathname)) throw new TypeError("WeChat endpoint path is invalid");
  if (url.pathname !== endpointPath(kind)) throw new TypeError("WeChat endpoint path is invalid");
  validateQuery(url, kind);
  return url;
}

export function resolveTencentRedirect(
  current: URL,
  location: string,
  kind: WeixinEndpointKind,
  hop: number,
  maxHops = DEFAULT_MAX_REDIRECTS,
): URL {
  if (!Number.isSafeInteger(hop) || hop < 1 || hop > maxHops) throw new TypeError("WeChat redirect limit exceeded");
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new TypeError("WeChat endpoint is not trusted");
  }
  return validateTencentUrl(next, kind);
}

function endpointPath(kind: WeixinEndpointKind): string {
  switch (kind) {
    case "qr-create": return "/ilink/bot/get_bot_qrcode";
    case "qr-status": return "/ilink/bot/get_qrcode_status";
    case "get-updates": return "/ilink/bot/getupdates";
    case "get-upload-url": return "/ilink/bot/getuploadurl";
    case "send-message": return "/ilink/bot/sendmessage";
    case "get-config": return "/ilink/bot/getconfig";
    case "send-typing": return "/ilink/bot/sendtyping";
    case "notify-start": return "/ilink/bot/msg/notifystart";
    case "notify-stop": return "/ilink/bot/msg/notifystop";
    case "cdn-download": return "/c2c/download";
    case "cdn-upload": return "/c2c/upload";
  }
}

function validateQuery(url: URL, kind: WeixinEndpointKind): void {
  if (kind === "cdn-download" || kind === "cdn-upload") return;
  if (kind === "qr-create") {
    if ([...url.searchParams.keys()].length !== 1 || url.searchParams.get("bot_type") !== "3") {
      throw new TypeError("WeChat endpoint query is invalid");
    }
    return;
  }
  if (kind === "qr-status") {
    const keys = [...url.searchParams.keys()];
    const qrcode = url.searchParams.get("qrcode");
    const verifyCode = url.searchParams.get("verify_code");
    if (
      !qrcode
      || keys.some((key) => key !== "qrcode" && key !== "verify_code")
      || url.searchParams.getAll("qrcode").length !== 1
      || url.searchParams.getAll("verify_code").length > 1
      || (verifyCode !== null && !/^\d+$/u.test(verifyCode))
    ) throw new TypeError("WeChat endpoint query is invalid");
    return;
  }
  if (url.search !== "") throw new TypeError("WeChat endpoint query is invalid");
}
