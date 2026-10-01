import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EnterpriseStoreBase } from "./store-base.js";
import { BindingStoreSupport } from "./binding-store-support.js";
import { CustomerStoreSupport } from "./customer-store-support.js";
import { SessionStoreSupport } from "./session-store-support.js";
import {
  ModelCredentialStore,
  type ModelCredentialEncryptionKey,
  type ModelCredentialInput,
  type ModelCredentialStatus,
} from "./model-credentials.js";

export interface EnterpriseStoreOptions {
  modelCredentialsEncryptionKey?: ModelCredentialEncryptionKey;
}

export class EnterpriseStore extends EnterpriseStoreBase {
  private readonly modelCredentials: ModelCredentialStore;
  private readonly customerStore: CustomerStoreSupport;
  private readonly bindingStore: BindingStoreSupport;
  private readonly sessionStore: SessionStoreSupport;

  private constructor(
    db: DatabaseSync,
    workspaceRoot: string,
    modelCredentialsEncryptionKey?: ModelCredentialEncryptionKey,
  ) {
    super(db, workspaceRoot);
    this.customerStore = new CustomerStoreSupport(db, workspaceRoot);
    this.bindingStore = new BindingStoreSupport(
      db,
      workspaceRoot,
      (actorId, customerId) => this.customerStore.getCustomer(actorId, customerId),
    );
    this.sessionStore = new SessionStoreSupport(
      db,
      workspaceRoot,
      (actorId, customerId) => this.customerStore.getCustomer(actorId, customerId),
      (actorId, customerId) => this.customerStore.getCustomerRuntimeTarget(actorId, customerId),
    );
    this.modelCredentials = new ModelCredentialStore(
      db,
      this.transaction.bind(this),
      this.membership.bind(this),
      modelCredentialsEncryptionKey,
    );
  }
  static async open(
    dbPath: string,
    workspaceRoot: string,
    options: EnterpriseStoreOptions = {},
  ): Promise<EnterpriseStore> {
    await mkdir(dirname(resolve(dbPath)), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const store = new EnterpriseStore(
      db,
      resolve(workspaceRoot),
      options.modelCredentialsEncryptionKey,
    );
    store.migrate();
    return store;
  }

  getCustomer(actorId: string, customerId: string) {
    return this.customerStore.getCustomer(actorId, customerId);
  }
  listCustomers(actorId: string, tenantId: string) {
    return this.customerStore.listCustomers(actorId, tenantId);
  }
  createCustomer(
    actorId: string,
    tenantId: string,
    input: { name: string; type?: string; metadata?: Record<string, unknown> },
  ) {
    return this.customerStore.createCustomer(actorId, tenantId, input);
  }
  updateCustomer(
    actorId: string,
    customerId: string,
    input: { name: string; type?: string; metadata?: Record<string, unknown> },
  ) {
    return this.customerStore.updateCustomer(actorId, customerId, input);
  }
  getCustomerRuntimeTarget(actorId: string, customerId: string) {
    return this.customerStore.getCustomerRuntimeTarget(actorId, customerId);
  }
  issueSession(userId: string, tokenHash: string, csrfHash: string) {
    return this.sessionStore.issueSession(userId, tokenHash, csrfHash);
  }
  resolveSession(tokenHash: string) {
    return this.sessionStore.resolveSession(tokenHash);
  }
  revokeSession(tokenHash: string): void {
    this.sessionStore.revokeSession(tokenHash);
  }
  matchesCsrf(sessionId: string, csrfHash: string): boolean {
    return this.sessionStore.matchesCsrf(sessionId, csrfHash);
  }
  activateCustomer(sessionId: string, customerId: string) {
    return this.sessionStore.activateCustomer(sessionId, customerId);
  }
  getActiveCustomer(sessionId: string) {
    return this.sessionStore.getActiveCustomer(sessionId);
  }
  getActiveRuntimeTarget(sessionId: string) {
    return this.sessionStore.getActiveRuntimeTarget(sessionId);
  }

  createCustomerSkill(actorId: string, customerId: string, input: { name: string; content: string }) {
    return this.bindingStore.createCustomerSkill(actorId, customerId, input);
  }
  listSkillsForCustomer(actorId: string, customerId: string) {
    return this.bindingStore.listSkillsForCustomer(actorId, customerId);
  }
  createCustomerMcpBinding(
    actorId: string,
    customerId: string,
    input: { name: string; endpoint: string; secretRef?: string | null },
  ) {
    return this.bindingStore.createCustomerMcpBinding(actorId, customerId, input);
  }
  listMcpBindingsForCustomer(actorId: string, customerId: string) {
    return this.bindingStore.listMcpBindingsForCustomer(actorId, customerId);
  }

  upsertModelCredential(
    actorId: string,
    tenantId: string,
    input: ModelCredentialInput,
  ): ModelCredentialStatus {
    return this.modelCredentials.upsertModelCredential(actorId, tenantId, input);
  }

  rotateModelCredential(
    actorId: string,
    tenantId: string,
    input: ModelCredentialInput,
  ): ModelCredentialStatus {
    return this.modelCredentials.rotateModelCredential(actorId, tenantId, input);
  }

  revokeModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
  ): ModelCredentialStatus {
    return this.modelCredentials.revokeModelCredential(actorId, tenantId, providerFamily);
  }

  deleteModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
  ): ModelCredentialStatus {
    return this.modelCredentials.deleteModelCredential(actorId, tenantId, providerFamily);
  }

  listModelCredentialStatuses(actorId: string, tenantId: string): ModelCredentialStatus[] {
    return this.modelCredentials.listModelCredentialStatuses(actorId, tenantId);
  }

  getModelCredentialForGateway(
    tenantId: string,
    providerFamily: string,
  ): ReturnType<ModelCredentialStore["getModelCredentialForGateway"]> {
    return this.modelCredentials.getModelCredentialForGateway(tenantId, providerFamily);
  }
}
