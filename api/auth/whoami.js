import { readSession } from '../../lib/session.js';

export default function handler(req, res) {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.status(200).json({
    authenticated: true,
    name: session.name
  });
}
