export function isHttpsUrlWithoutCredentials(value: string) {
  if (
    !/^https:\/\/[^/?#@]+(?:[/?#].*)?$/i.test(value) ||
    /[\s\\]/.test(value) ||
    !URL.canParse(value)
  )
    return false;
  const { hostname, username, password } = new URL(value);
  return !!hostname && !username && !password;
}
