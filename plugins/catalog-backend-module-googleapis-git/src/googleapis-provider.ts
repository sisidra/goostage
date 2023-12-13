import { Entity, SystemEntity, ApiEntity, ComponentEntity } from '@backstage/catalog-model';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import fs from 'fs';
import { exec } from "child_process";
import { promisify } from "util";
import { load } from "js-yaml";


const execAsync = promisify(exec);

/**
 * Provides entities from cloned googleapis repo.
 *
 * TODO: Use https://github.com/zalopay-oss/backstage-grpc-playground as well.
 */
export class GoogleapisProvider implements EntityProvider {
  private static readonly APIS_REPO = "https://github.com/googleapis/googleapis.git";
  private static readonly APIS_ROOT = "temp/googleapis";
  private static readonly PROTO_REPO = "https://github.com/protocolbuffers/protobuf.git";
  private static readonly PROTO_ROOT = "temp/protobuf/src";

  private readonly env: string;
  private connection?: EntityProviderConnection;

  constructor(env: string) {
    this.env = env;
  }

  getProviderName(): string {
    return `googleapis-${this.env}`;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
  }

  async run(): Promise<void> {
    if (!this.connection) {
      throw new Error('Not initialized');
    }

    await this.cloneRepos(GoogleapisProvider.APIS_REPO, GoogleapisProvider.APIS_ROOT);
    await this.cloneRepos(GoogleapisProvider.PROTO_REPO, GoogleapisProvider.PROTO_ROOT);
    const systems = this.discoverSystems(`${GoogleapisProvider.APIS_ROOT}/google`);
    const components = this.discoverSystemComponents(systems);
    const apis = this.discoverApis(components);

    console.log(`Systems:\t${systems.size}\nServices:\t${components.size}\nAPIs:\t${apis.length}`);

    await this.connection.applyMutation({
      type: 'full',
      entities: [...systems.values(), ...components.values(), ...apis].map(entity => ({
        entity,
        locationKey: `googleapis-provider:${this.env}`,
      })),
    });
  }

  async cloneRepos(repo: string, root: string): Promise<void> {
    if (fs.existsSync(root)) {
      console.log(`${root} directory exists`);
      return Promise.resolve();
    }
    console.log(`${root} directory missing`);
    fs.mkdirSync(root, { recursive: true });

    const result = await execAsync(`git clone --depth 1 ${repo} ${root}`);
    console.log(`Cloned googleapis ${result}`);
    return Promise.resolve();
  }

  discoverSystems(path: string): Map<fs.PathLike, SystemEntity> {
    const result = new Map<fs.PathLike, SystemEntity>();

    for (const dirent of fs.readdirSync(path, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const systemPath = `${dirent.path}/${dirent.name}`;

      console.log(`System: ${dirent.name}\t${systemPath}`);
      result.set(systemPath, {
        apiVersion: 'backstage.io/v1beta1',
        kind: 'System',
        metadata: {
          name: dirent.name,
          annotations: {
            "backstage.io/managed-by-location": `url:${GoogleapisProvider.APIS_REPO}`,
            "backstage.io/managed-by-origin-location": `url:${GoogleapisProvider.APIS_REPO}`,
          },
          links: [{
            title: "Github",
            url: `https://github.com/googleapis/googleapis/tree/master/google/${dirent.name}`,
          }]
        },
        spec: {
          owner: "default/guests",
        }
      });
    }

    return result;
  }

  discoverSystemComponents(systems: Map<fs.PathLike, SystemEntity>): Map<fs.PathLike, ComponentEntity> {
    const result = new Map<fs.PathLike, ComponentEntity>();

    for (const [systemPath, system] of systems) {
      for (const component of this.discoverComponents(systemPath, system)) {
        result.set(component.path, component.value);
      }
    }

    return result;
  }

  * discoverComponents(path: fs.PathLike, system: SystemEntity): Generator<{ path: fs.PathLike, value: ComponentEntity }> {
    console.log(`Path: ${path}`);

    let serviceDef: any = null;
    for (const dirent of fs.readdirSync(path, { withFileTypes: true })) {
      if (dirent.isFile() && dirent.name.endsWith(".yaml")) {
        const yamlData: any = load(fs.readFileSync(`${dirent.path}/${dirent.name}`, "utf8"));
        if (yamlData.type === "google.api.Service") {
          serviceDef = yamlData;
          break;
        }
      }
    }

    if (serviceDef !== null) {
      const name = serviceDef.name.split(".")[0];
      console.log(`Service: ${name}\t${path}`);
      const title = serviceDef.title ?? null;
      const description = `${serviceDef.documentation?.summary ?? ""}\n${serviceDef.documentation?.overview ?? ""}`;
      yield {
        path: path,
        value: {
          apiVersion: 'backstage.io/v1beta1',
          kind: 'Component',
          metadata: {
            name: name,
            title: title,
            description: description,
            annotations: {
              "backstage.io/managed-by-location": `url:${GoogleapisProvider.APIS_REPO}`,
              "backstage.io/managed-by-origin-location": `url:${GoogleapisProvider.APIS_REPO}`,
            },
            links: [{
              title: "Github",
              url: `https://github.com/googleapis/googleapis/tree/master${path.substring(GoogleapisProvider.APIS_ROOT.length)}`,
            }]
          },
          spec: {
            type: "service",
            lifecycle: "production",
            system: system.metadata.name,
            owner: "default/guests",
            providesApis: [],
          },
        }
      };
    } else {
      for (const dirent of fs.readdirSync(path, { withFileTypes: true })) {
        if (dirent.isDirectory()) {
          const subpath = `${dirent.path}/${dirent.name}`;
          yield* this.discoverComponents(subpath, system);
        }
      }
    }
  }

  discoverApis(components: Map<fs.PathLike, ComponentEntity>): ApiEntity[] {
    const results: ApiEntity[] = [];

    for (const [componentRoot, component] of components) {
      for (const dirent of fs.readdirSync(componentRoot, { withFileTypes: true })) {
        if (!dirent.isFile() || !dirent.name.endsWith(".proto")) {
          continue;
        }

        const filePath = `${dirent.path}/${dirent.name}`;
        const protoContent = fs.readFileSync(filePath, "utf8");
        const protoLines = protoContent.split("\n");
        let servicePackage: string | undefined;
        let serviceName: string | undefined;
        let serviceImports: string[] = [];
        for (const protoLine of protoLines) {
          if (protoLine.startsWith("package ")) {
            servicePackage = protoLine.slice("package ".length, -1);
          } else if (serviceName === undefined && protoLine.startsWith("service ")) {
            serviceName = protoLine.match(/service (\w+).*/)?.[1];
          } else if (protoLine.startsWith("import ")) {
            const match = protoLine.match(/import "(.*)";/);
            if (match != null) serviceImports.push(match[1]);
          }
        }

        if (serviceName !== undefined) {
          const namespace = servicePackage?.replaceAll(".", "-");
          results.push({
            apiVersion: "backstage.io/v1alpha1",
            kind: "API",
            metadata: {
              name: serviceName,
              namespace: namespace,
              annotations: {
                "backstage.io/managed-by-location": `url:${GoogleapisProvider.APIS_REPO}`,
                "backstage.io/managed-by-origin-location": `url:${GoogleapisProvider.APIS_REPO}`,
              },
            },
            spec: {
              type: "grpc",
              lifecycle: "production",
              owner: "default/guests",
              definition: {
                "$text": `https://github.com/googleapis/googleapis/tree/master${dirent.path.substring(GoogleapisProvider.APIS_ROOT.length)}/${dirent.name}`,
              },
              files: serviceImports.map(importPath => {
                let fullImportPath = `${GoogleapisProvider.APIS_ROOT}/${importPath}`;
                if (!fs.existsSync(fullImportPath)) {
                  fullImportPath = `${GoogleapisProvider.PROTO_ROOT}/${importPath}`;
                }
                if (!fs.existsSync(fullImportPath)) {
                  console.log(`Missing: ${fullImportPath}`);
                }

                return {
                  file_name: importPath.split("/")[-1],
                  file_path: fullImportPath,
                };
              }),
            },
          });

          component.spec.providesApis!.push(`${namespace}/${serviceName}`)
        }
      }
    }

    return results;
  }

}
