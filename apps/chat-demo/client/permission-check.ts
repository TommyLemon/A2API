/** Mirror runtime sensitivity helpers for browser write path. */

/** APIJSON outermost `code: 401` = not logged in / session expired. */
export function isLoginSessionIssue(code?: number): boolean {
  return code === 401;
}

/** Access/Request config gates — not login/session expiry. */
export function isPermissionGateIssue(
  message: string,
  code?: number,
): boolean {
  if (isLoginSessionIssue(code)) return false;
  if (code === 403) return true;
  return /no Request row|找不到.*structure|非开放请求|Request 表|nothing was written|no row ids|没有权限|无权限|不允许|无访问|权限不足|Access denied|role\b.*不允许|不是本人|禁止|forbidden|unauthorized|403/i.test(
    message,
  );
}

/**
 * Errors that should auto-submit Admin Apply from demo (not local Approve/Reject).
 * Permission gates + APIJSON parameter / illegal-request failures.
 * Login/session expiry is excluded — that needs re-login.
 */
export function isApplyTriggerIssue(
  message: string,
  code?: number,
): boolean {
  if (isLoginSessionIssue(code)) return false;
  if (isPermissionGateIssue(message, code)) return true;
  // APIJSON often returns outermost code 400 with 参数错误 / 不合法
  if (code === 400) return true;
  return /参数错误|参数不合法|不合法|非法|invalid\s*(argument|param|request)|illegal|bad request/i.test(
    message,
  );
}
