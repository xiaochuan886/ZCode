import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EnterpriseStoreBase } from "./store-base.js";
import { BindingStoreSupport } from "./binding-store-support.js";
import { CustomerStoreSupport } from "./customer-store-support.js";
import { SessionStoreSupport } from "./session-store-support.js";
import { ConnectorStoreSupport, type McpConnectorForRelay } from "./connector-store-support.js";
import { ProviderStoreSupport } from "./provider-store-support.js";
import type { TenantModelProviderInput, TenantModelProviderPatch } from "./provider-format.js";
import type {
  TenantMcpConnectorInput,
  TenantMcpConnectorPatch,
} from "./connector-store-support.js";
import type {
  TenantMcpConnector,
  TenantMcpConnectorDistribution,
  TenantModelProvider,
  TenantModelProviderDistribution,
} from "./types.js";
import type { ModelCredentialEncryptionKey } from "./model-credential-format.js";

export interface EnterpriseStoreOptions {
  modelCredentialsEncryptionKey?: ModelCredentialEncryptionKey;
}

export class EnterpriseStore extends EnterpriseStoreBase {
  private readonly providerStore: ProviderStoreSupport;
  private readonly connectorStore: ConnectorStoreSupport;
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
    this.bindingStore = new BindingStoreSupport(db, workspaceRoot, (actorId, customerId) =>
      this.customerStore.getCustomer(actorId, customerId),
    );
    this.sessionStore = new SessionStoreSupport(
      db,
      workspaceRoot,
      (actorId, customerId) => this.customerStore.getCustomer(actorId, customerId),
      (actorId, customerId) => this.customerStore.getCustomerRuntimeTarget(actorId, customerId),
    );
    this.providerStore = new ProviderStoreSupport(db, modelCredentialsEncryptionKey);
    this.connectorStore = new ConnectorStoreSupport(db);
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
    store.migrate({
      // v7 迁移在同一事务内把 legacy 单凭据 seed 成供应商目录行。
      seedTenantCatalogV7: () => store.providerStore.seedFromLegacyCredentials(),
    });
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
  expertRuntimeTargetsForTenant(actorId: string, tenantId: string) {
    return this.customerStore.expertRuntimeTargetsForTenant(actorId, tenantId);
  }
  deleteCustomer(actorId: string, customerId: string) {
    return this.customerStore.deleteCustomer(actorId, customerId);
  }
  writeCustomerAgentsFile(customer: import("./types.js").Customer) {
    return this.customerStore.writeCustomerAgentsFile(customer);
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

  createCustomerSkill(
    actorId: string,
    customerId: string,
    input: { name: string; content: string },
  ) {
    return this.bindingStore.createCustomerSkill(actorId, customerId, input);
  }
  listSkillsForCustomer(actorId: string, customerId: string) {
    return this.bindingStore.listSkillsForCustomer(actorId, customerId);
  }
  listTenantSkills(actorId: string, tenantId: string) {
    return this.bindingStore.listTenantSkills(actorId, tenantId);
  }
  createTenantSkill(actorId: string, tenantId: string, input: { name: string; content: string }) {
    return this.bindingStore.createTenantSkill(actorId, tenantId, input);
  }
  deleteTenantSkill(actorId: string, tenantId: string, skillId: string) {
    this.bindingStore.deleteTenantSkill(actorId, tenantId, skillId);
  }
  tenantSkillsForDistribution(tenantId: string) {
    return this.bindingStore.tenantSkillsForDistribution(tenantId);
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
  ensureMcpBindingToken(bindingId: string) {
    return this.bindingStore.ensureMcpBindingToken(bindingId);
  }
  findMcpBindingForRelay(customerId: string, bindingId: string, token: string) {
    return this.bindingStore.findMcpBindingForRelay(customerId, bindingId, token);
  }

  listTenantModelProviders(actorId: string, tenantId: string): TenantModelProvider[] {
    return this.providerStore.listTenantModelProviders(actorId, tenantId);
  }
  getTenantModelProvider(actorId: string, providerId: string): TenantModelProvider {
    return this.providerStore.getTenantModelProvider(actorId, providerId);
  }
  createTenantModelProvider(
    actorId: string,
    tenantId: string,
    input: TenantModelProviderInput,
  ): TenantModelProvider {
    return this.providerStore.createTenantModelProvider(actorId, tenantId, input);
  }
  updateTenantModelProvider(
    actorId: string,
    providerId: string,
    patch: TenantModelProviderPatch,
  ): TenantModelProvider {
    return this.providerStore.updateTenantModelProvider(actorId, providerId, patch);
  }
  deleteTenantModelProvider(actorId: string, providerId: string): void {
    this.providerStore.deleteTenantModelProvider(actorId, providerId);
  }
  tenantModelProvidersForDistribution(tenantId: string): TenantModelProviderDistribution[] {
    return this.providerStore.tenantModelProvidersForDistribution(tenantId);
  }
  tenantModelProviderForConnectionTest(
    actorId: string,
    providerId: string,
  ): TenantModelProviderDistribution {
    return this.providerStore.tenantModelProviderForConnectionTest(actorId, providerId);
  }

  listTenantMcpConnectors(actorId: string, tenantId: string): TenantMcpConnector[] {
    return this.connectorStore.listTenantMcpConnectors(actorId, tenantId);
  }
  getTenantMcpConnector(actorId: string, connectorId: string): TenantMcpConnector {
    return this.connectorStore.getTenantMcpConnector(actorId, connectorId);
  }
  createTenantMcpConnector(
    actorId: string,
    tenantId: string,
    input: TenantMcpConnectorInput,
  ): TenantMcpConnector {
    return this.connectorStore.createTenantMcpConnector(actorId, tenantId, input);
  }
  updateTenantMcpConnector(
    actorId: string,
    connectorId: string,
    patch: TenantMcpConnectorPatch,
  ): TenantMcpConnector {
    return this.connectorStore.updateTenantMcpConnector(actorId, connectorId, patch);
  }
  deleteTenantMcpConnector(actorId: string, connectorId: string): void {
    this.connectorStore.deleteTenantMcpConnector(actorId, connectorId);
  }
  tenantMcpConnectorsForDistribution(tenantId: string): TenantMcpConnectorDistribution[] {
    return this.connectorStore.tenantMcpConnectorsForDistribution(tenantId);
  }
  ensureMcpConnectorToken(connectorId: string): string {
    return this.connectorStore.ensureMcpConnectorToken(connectorId);
  }
  findMcpConnectorForRelay(connectorId: string, token: string): McpConnectorForRelay | null {
    return this.connectorStore.findMcpConnectorForRelay(connectorId, token);
  }
}
