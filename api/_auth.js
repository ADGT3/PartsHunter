/* Access-control seam.
 * v1 is intentionally OPEN (single-user, no login) but all access checks funnel
 * through here so a later version can enforce auth in ONE place without touching
 * every endpoint. To turn it on later: set APP_PASSWORD and check a signed cookie
 * / Authorization header here, returning false + a 401 when it fails.
 */
export function requireAuth(req, res) {
  const required = process.env.APP_PASSWORD;
  if (!required) return true; // open until a password is configured
  const provided = req.headers['x-app-password'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided && provided === required) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
