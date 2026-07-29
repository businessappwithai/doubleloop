/**
 * @generated SignedSource<<0e2faf0e997e8e8b381672abba8c43ff>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type UpdateConceptMetadataInput = {
  bundleId: string;
  expectedVersion: number;
  id: string;
  isIndex?: boolean | null | undefined;
  title?: string | null | undefined;
};
export type ConceptRouteUpdateTitleMutation$variables = {
  input: UpdateConceptMetadataInput;
};
export type ConceptRouteUpdateTitleMutation$data = {
  readonly updateConceptMetadata: {
    readonly concept: {
      readonly id: string;
      readonly title: string;
      readonly updatedAt: any;
      readonly version: number;
    };
  };
};
export type ConceptRouteUpdateTitleMutation = {
  response: ConceptRouteUpdateTitleMutation$data;
  variables: ConceptRouteUpdateTitleMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "input"
  }
],
v1 = [
  {
    "kind": "ClientExtension",
    "selections": [
      {
        "alias": null,
        "args": [
          {
            "kind": "Variable",
            "name": "input",
            "variableName": "input"
          }
        ],
        "concreteType": "UpdateConceptMetadataPayload",
        "kind": "LinkedField",
        "name": "updateConceptMetadata",
        "plural": false,
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "Concept",
            "kind": "LinkedField",
            "name": "concept",
            "plural": false,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "id",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "title",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "version",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "updatedAt",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ]
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "ConceptRouteUpdateTitleMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "ConceptRouteUpdateTitleMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "4608888e0f5d40b318342444369f9f27",
    "id": null,
    "metadata": {},
    "name": "ConceptRouteUpdateTitleMutation",
    "operationKind": "mutation",
    "text": null
  }
};
})();

(node as any).hash = "5e96b4fc44dfe761d31d0e2e01fc35f0";

export default node;
