/**
 * @generated SignedSource<<9316b50ef5fab1c9c4983012f0cbe00c>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type TrustLevel = "HUMAN_REVIEWED" | "MACHINE_CONFIRMED" | "UNVERIFIED" | "%future added value";
export type IndexBundlesQuery$variables = {
  first?: number | null | undefined;
  workspaceId: string;
};
export type IndexBundlesQuery$data = {
  readonly bundles: {
    readonly edges: ReadonlyArray<{
      readonly node: {
        readonly conceptCount: number;
        readonly defaultTrust: TrustLevel;
        readonly description: string;
        readonly id: string;
        readonly slug: string;
        readonly title: string;
      };
    }>;
    readonly totalCount: number;
  };
};
export type IndexBundlesQuery = {
  response: IndexBundlesQuery$data;
  variables: IndexBundlesQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "first"
},
v1 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "workspaceId"
},
v2 = [
  {
    "kind": "ClientExtension",
    "selections": [
      {
        "alias": null,
        "args": [
          {
            "kind": "Variable",
            "name": "first",
            "variableName": "first"
          },
          {
            "kind": "Variable",
            "name": "workspaceId",
            "variableName": "workspaceId"
          }
        ],
        "concreteType": "BundleConnection",
        "kind": "LinkedField",
        "name": "bundles",
        "plural": false,
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "BundleEdge",
            "kind": "LinkedField",
            "name": "edges",
            "plural": true,
            "selections": [
              {
                "alias": null,
                "args": null,
                "concreteType": "Bundle",
                "kind": "LinkedField",
                "name": "node",
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
                    "name": "slug",
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
                    "name": "description",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "conceptCount",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "defaultTrust",
                    "storageKey": null
                  }
                ],
                "storageKey": null
              }
            ],
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "totalCount",
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
    "argumentDefinitions": [
      (v0/*:: as any*/),
      (v1/*:: as any*/)
    ],
    "kind": "Fragment",
    "metadata": null,
    "name": "IndexBundlesQuery",
    "selections": (v2/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [
      (v1/*:: as any*/),
      (v0/*:: as any*/)
    ],
    "kind": "Operation",
    "name": "IndexBundlesQuery",
    "selections": (v2/*:: as any*/)
  },
  "params": {
    "cacheID": "5c45c2286d7c2c5b3f2355eb684a93f3",
    "id": null,
    "metadata": {},
    "name": "IndexBundlesQuery",
    "operationKind": "query",
    "text": null
  }
};
})();

(node as any).hash = "b94828dc3fb1ff65cc14871e94b25959";

export default node;
