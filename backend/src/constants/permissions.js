// src/constants/permissions.js
const PERMS = Object.freeze({
  // Sessions
  SESSIONS_READ_OWN_CLINIC:  'sessions:read:own_clinic',
  SESSIONS_READ_ALL:         'sessions:read:all',
  SESSIONS_WRITE_OWN_CLINIC: 'sessions:write:own_clinic',
  SESSIONS_WRITE_ALL:        'sessions:write:all',

  // Session commentaries
  SESSION_COMMENTARIES_READ_OWN_CLINIC:  'session_commentaries:read:own_clinic',
  SESSION_COMMENTARIES_READ_ALL:         'session_commentaries:read:all',
  SESSION_COMMENTARIES_WRITE_OWN_CLINIC: 'session_commentaries:write:own_clinic',
  SESSION_COMMENTARIES_WRITE_ALL:        'session_commentaries:write:all',

  // Clients
  CLIENTS_READ_OWN_CLINIC:  'clients:read:own_clinic',
  CLIENTS_READ_ALL:         'clients:read:all',
  CLIENTS_WRITE_OWN_CLINIC: 'clients:write:own_clinic',
  CLIENTS_WRITE_ALL:        'clients:write:all',

  // Client histories
  CLIENT_HISTORIES_READ_OWN_CLINIC:  'client_histories:read:own_clinic',
  CLIENT_HISTORIES_READ_ALL:         'client_histories:read:all',
  CLIENT_HISTORIES_WRITE_OWN_CLINIC: 'client_histories:write:own_clinic',
  CLIENT_HISTORIES_WRITE_ALL:        'client_histories:write:all',

  // Users
  USERS_READ_ALL:  'users:read:all',
  USERS_WRITE_ALL: 'users:write:all',

  // Insights
  INSIGHTS_READ_OWN_CLINIC: 'insights:read:own_clinic',
  INSIGHTS_READ_ALL:        'insights:read:all',
  INSIGHTS_WRITE_OWN_CLINIC: 'insights:write:own_clinic',
  INSIGHTS_WRITE_ALL:        'insights:write:all',

  // Clinics
  CLINICS_READ_OWN:  'clinics:read:own',
  CLINICS_READ_ALL:  'clinics:read:all',
  CLINICS_WRITE_ALL: 'clinics:write:all',

  // Site settings
  SITE_SETTINGS_MANAGE_ALL: 'site_settings:manage:all',

  // Events
  EVENTS_READ_OWN_CLINIC: 'events:read:own_clinic',
  EVENTS_READ_ALL:        'events:read:all',
  EVENTS_WRITE_OWN_CLINIC: 'events:write:own_clinic',
  EVENTS_WRITE_ALL:        'events:write:all',
})

export default PERMS
