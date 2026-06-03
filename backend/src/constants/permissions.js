// src/constants/permissions.js
const PERMS = Object.freeze({
  // Sessions
  SESSIONS_READ_OWN_CLINIC:  'sessions:read:own_clinic',
  SESSIONS_READ_ALL:         'sessions:read:all',
  SESSIONS_WRITE_OWN_CLINIC: 'sessions:write:own_clinic',
  SESSIONS_WRITE_ALL:        'sessions:write:all',

  // Clients
  CLIENTS_READ_OWN_CLINIC:  'clients:read:own_clinic',
  CLIENTS_READ_ALL:         'clients:read:all',
  CLIENTS_WRITE_OWN_CLINIC: 'clients:write:own_clinic',
  CLIENTS_WRITE_ALL:        'clients:write:all',

  // Users
  USERS_READ_ALL:  'users:read:all',
  USERS_WRITE_ALL: 'users:write:all',

  // Insights
  INSIGHTS_READ_OWN_CLINIC: 'insights:read:own_clinic',
  INSIGHTS_READ_ALL:        'insights:read:all',

  // Clinics
  CLINICS_READ_OWN:  'clinics:read:own',
  CLINICS_READ_ALL:  'clinics:read:all',
  CLINICS_WRITE_ALL: 'clinics:write:all',
})

export default PERMS