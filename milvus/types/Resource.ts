import { GrpcTimeOut, resStatusResponse } from './Common';

export interface CreateResourceGroupReq extends GrpcTimeOut {
  resource_group: string;
}
export interface DropResourceGroupsReq extends CreateResourceGroupReq {}
export interface DescribeResourceGroupsReq extends CreateResourceGroupReq {}

export interface TransferNodeReq extends GrpcTimeOut {
  source_resource_group: string;
  target_resource_group: string;
  num_node: number;
}

export interface TransferReplicaReq extends GrpcTimeOut {
  source_resource_group: string;
  target_resource_group: string;
  collection_name: string;
  num_replica: number;
}

export interface ListResourceGroupsResponse extends resStatusResponse {
  resource_groups: string[];
}

type ResourceGroup = {
  name: string;
  capacity: number;
  num_available_node: number;
  num_loaded_replica: { [key: string]: number };
  num_outgoing_node: { [key: string]: number };
  num_incoming_node: { [key: string]: number };
};

export interface DescribeResourceGroupResponse extends resStatusResponse {
  resource_group: ResourceGroup;
}
