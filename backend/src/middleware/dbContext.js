import pool from '../config/db.js';

const dbContext = async (req, res, next) => {
  const client = await pool.connect();
  req.dbClient = client;

  console.log('DB context initialized for user:', req.user?.email || 'unknown');

  try {
    const clinicId = req.user?.clinic_id ?? null;
    const isAdmin = req.user?.role === 'admin' || req.user?.role === 'superadmin' || false;

    // ✅ Avoid pg's untyped NULL bug: SET if exists, RESET if null
    if (clinicId) {
      await client.query("SELECT set_config('app.current_clinic_id', $1, false)", [clinicId]);
    } else {
      await client.query("RESET app.current_clinic_id");
    }

    // is_admin is always a string ('true'/'false'), so pg infers text correctly
    await client.query("SELECT set_config('app.is_admin', $1, false)", [String(isAdmin)]);

    // Guarantee cleanup exactly once when the response finishes
    res.on('finish', async () => {
      try {
        await client.query("RESET app.current_clinic_id; RESET app.is_admin;");
      } catch (err) {
        console.error('Failed to reset DB session variables:', err);
      } finally {
        client.release();
      }
    });

    next();
  } catch (err) {
    console.error('Failed to set DB session variables:', err);
    client.release();
    next(err);
  }
};

export default dbContext;