import type {
  CreateContextPackageRequest,
  CreateContextPackageResponse,
  GetContextPackageResponse,
  ListContextPackagesQuery,
  ListContextPackagesResponse,
} from "@orca/contracts";
import {
  createContextPackage as createContextPackageRequest,
  getContextPackage as getContextPackageRequest,
  listContextPackages as listContextPackagesRequest,
} from "../api";

export function createContextPackage(
  goalId: string,
  request: CreateContextPackageRequest,
): Promise<CreateContextPackageResponse> {
  return createContextPackageRequest(goalId, request);
}

export function listContextPackages(
  goalId: string,
  query?: ListContextPackagesQuery,
): Promise<ListContextPackagesResponse> {
  return listContextPackagesRequest(goalId, query);
}

export function getContextPackage(packageId: string): Promise<GetContextPackageResponse> {
  return getContextPackageRequest(packageId);
}
