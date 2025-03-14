// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import * as cedar from 'vscode-cedar-wasm';
import * as path from 'node:path';
import {
  addPolicyResultErrors,
  addSyntaxDiagnosticErrors,
  reportFormatterOff,
} from './diagnostics';
import {
  CEDAR_ENTITIES_EXTENSION_JSON,
  CEDAR_ENTITIES_FILE,
  CEDAR_SCHEMA_EXTENSION_JSON,
  CEDAR_SCHEMA_FILE,
  getSchemaTextDocument,
} from './fileutil';
import { parseCedarDocPolicies } from './parser';

type ValidationCacheItem = {
  version: number;
  valid: boolean;
};

class ValidationCache {
  docsBySchema: Record<string, Set<string>> = {};
  cache: Record<string, ValidationCacheItem> = {};
  constructor() {}

  check(doc: vscode.TextDocument): ValidationCacheItem | null {
    const cachedItem = this.cache[doc.uri.toString()];
    if (cachedItem && cachedItem.version === doc.version) {
      return cachedItem;
    }

    return null;
  }

  store(doc: vscode.TextDocument, success: boolean) {
    this.cache[doc.uri.toString()] = {
      version: doc.version,
      valid: success,
    };
  }

  clear() {
    this.cache = {};
    this.docsBySchema = {};
  }

  associateSchemaWithDoc(
    schemaDoc: vscode.TextDocument,
    doc: vscode.TextDocument
  ) {
    const s = this.docsBySchema[schemaDoc.uri.toString()] || new Set();
    s.add(doc.uri.toString());
    this.docsBySchema[schemaDoc.uri.toString()] = s;
  }

  revalidateSchema(
    schemaDoc: vscode.TextDocument,
    diagnosticCollection: vscode.DiagnosticCollection
  ) {
    const docs = this.docsBySchema[schemaDoc.uri.toString()];
    if (docs) {
      docs.forEach((docUri) => {
        delete this.cache[docUri];
        const textDoc = vscode.workspace.openTextDocument(
          vscode.Uri.parse(docUri)
        );
        textDoc.then((doc) => {
          validateTextDocument(doc, diagnosticCollection);
        });
      });
    }
  }
}

const validationCache = new ValidationCache();
export const clearValidationCache = () => {
  validationCache.clear();
};

export const validateTextDocument = (
  doc: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
) => {
  if (doc.uri.scheme !== 'file') {
    // don't validate vscode-local-history or other non-file URIs
    return;
  }
  if (doc.languageId === 'cedar') {
    validateCedarDoc(doc, diagnosticCollection);
  } else if (
    doc.fileName.endsWith(path.sep + CEDAR_SCHEMA_FILE) ||
    doc.fileName.endsWith(CEDAR_SCHEMA_EXTENSION_JSON)
  ) {
    validateSchemaDoc(doc, diagnosticCollection);
  } else if (
    doc.fileName.endsWith(path.sep + CEDAR_ENTITIES_FILE) ||
    doc.fileName.endsWith(CEDAR_ENTITIES_EXTENSION_JSON)
  ) {
    validateEntitiesDoc(doc, diagnosticCollection);
  }
};

export const validateCedarDoc = async (
  cedarDoc: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection,
  userInitiated: boolean = false
): Promise<boolean> => {
  if (!userInitiated) {
    const cachedItem = validationCache.check(cedarDoc);
    if (cachedItem) {
      // console.log(`validateCedarDoc (cached) ${cedarDoc.uri.toString()}`);
      return Promise.resolve(cachedItem.valid);
    }
  }
  // console.log(`validateCedarDoc ${cedarDoc.uri.toString()}`);

  const diagnostics: vscode.Diagnostic[] = [];
  reportFormatterOff(cedarDoc, diagnostics);
  const syntaxResult: cedar.ValidateSyntaxResult = cedar.validateSyntax(
    cedarDoc.getText()
  );
  let success = syntaxResult.success;
  if (syntaxResult.errors) {
    addSyntaxDiagnosticErrors(diagnostics, syntaxResult.errors, cedarDoc);
  } else {
    const schemaDoc = await getSchemaTextDocument(diagnostics, cedarDoc);
    if (schemaDoc) {
      if (validateSchemaDoc(schemaDoc, diagnosticCollection, userInitiated)) {
        validationCache.associateSchemaWithDoc(schemaDoc, cedarDoc);

        parseCedarDocPolicies(cedarDoc, (policyRange, policyText) => {
          const policyResult: cedar.ValidatePolicyResult = cedar.validatePolicy(
            schemaDoc.getText(),
            policyText
          );
          if (policyResult.success === false && policyResult.errors) {
            addPolicyResultErrors(
              diagnostics,
              policyResult.errors,
              policyText,
              policyRange.effectRange,
              policyRange.range.start.line
            );
          }
          policyResult.free();
        });
      }
    }
  }
  diagnosticCollection.set(cedarDoc.uri, diagnostics);
  syntaxResult.free();

  validationCache.store(cedarDoc, success);

  return Promise.resolve(success);
};

export const validateSchemaDoc = (
  schemaDoc: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection,
  userInitiated: boolean = false
): boolean => {
  if (!userInitiated) {
    const cachedItem = validationCache.check(schemaDoc);
    if (cachedItem) {
      // console.log(`validateSchemaDoc (cached) ${schemaDoc.uri.toString()}`);
      return cachedItem.valid;
    }
  }
  // console.log(`validateSchemaDoc ${schemaDoc.uri.toString()}`);

  const schema = schemaDoc.getText();
  const schemaResult: cedar.ValidateSchemaResult = cedar.validateSchema(schema);
  const success = schemaResult.success;
  if (schemaResult.success === false && schemaResult.errors) {
    let schemaDiagnostics: vscode.Diagnostic[] = [];
    addSyntaxDiagnosticErrors(
      schemaDiagnostics,
      schemaResult.errors,
      schemaDoc
    );
    diagnosticCollection.set(schemaDoc.uri, schemaDiagnostics);
  } else {
    // reset any errors for the schema from a previous validateSchema
    diagnosticCollection.delete(schemaDoc.uri);

    // revalidate any Cedar files using this schema
    validationCache.revalidateSchema(schemaDoc, diagnosticCollection);
  }
  schemaResult.free();

  validationCache.store(schemaDoc, success);

  return success;
};

export const validateEntitiesDoc = async (
  entitiesDoc: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection,
  userInitiated: boolean = false
): Promise<boolean> => {
  if (!userInitiated) {
    const cachedItem = validationCache.check(entitiesDoc);
    if (cachedItem) {
      // console.log(`validateEntitiesDoc (cached) ${entitiesDoc.uri.toString()}`);
      return Promise.resolve(cachedItem.valid);
    }
  }
  // console.log(`validateEntitiesDoc ${entitiesDoc.uri.toString()}`);

  let success = false;
  let entitiesDiagnostics: vscode.Diagnostic[] = [];

  const entities = entitiesDoc.getText();
  const schemaDoc = await getSchemaTextDocument(
    entitiesDiagnostics,
    entitiesDoc
  );
  if (schemaDoc) {
    if (validateSchemaDoc(schemaDoc, diagnosticCollection, userInitiated)) {
      validationCache.associateSchemaWithDoc(schemaDoc, entitiesDoc);

      const entitiesResult: cedar.ValidateEntitiesResult =
        cedar.validateEntities(entities, schemaDoc.getText());
      success = entitiesResult.success;
      if (entitiesResult.success === false && entitiesResult.errors) {
        addSyntaxDiagnosticErrors(
          entitiesDiagnostics,
          entitiesResult.errors,
          entitiesDoc
        );
      }
      entitiesResult.free();
    }
  } else {
    if (userInitiated) {
      vscode.window.showErrorMessage(
        `Cedar schema file not found or configured in settings.json`
      );
    }
  }

  diagnosticCollection.set(entitiesDoc.uri, entitiesDiagnostics);

  validationCache.store(entitiesDoc, success);

  return Promise.resolve(success);
};
