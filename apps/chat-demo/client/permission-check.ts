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
  return /no Request row|没有权限|无权限|不允许|无访问|权限不足|Access denied|role\b.*不允许|不是本人|禁止|forbidden|unauthorized|403/i.test(
    message,
  );
}
