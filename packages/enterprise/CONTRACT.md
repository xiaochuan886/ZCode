# Enterprise module

`EnterpriseStore` owns tenant records, memberships, Cases and browser sessions in SQLite. `EnterpriseAuth` owns password verification and bearer/CSRF tokens. Other modules call the public package entrypoint; they do not access database tables or runtime internals. Case-scoped reads require an actor user ID and verify current membership. The gateway resolves the active Case on every request.
