// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// vkprobe STAGE: vk-trial's child. Goes through the stages in order and
// stops after STAGE, so each try on the car goes one step further than the
// last one that came back:
//
//   instance   the loader and the driver load, an instance (no device yet)
//   enumerate  the physical device: ANV opens the render node and asks the
//              kernel its parameters (and makes a test context)
//   device     a logical device and its queue: a GPU context
//   compute    a compute shader on 1024 numbers, submitted and waited for
//              (5 s), the result checked on the CPU
//
// Never asks for VK_KHR_display (that would open the display node). Each
// stage leaves a crumb (vk_crumbs.so) before and after. On the bench's stub
// GPU nothing runs, so the numbers come back unchanged: accepted there
// (INTEL_STUB_GPU_PLATFORM set) as "not run".

#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>
#include "compute.spv.h"

#define COUNT 1024

static void (*crumb_fn)(const char *, ...);
#define CRUMB(...) do { if (crumb_fn) crumb_fn(__VA_ARGS__); } while (0)

static int stop_after;
static const char *NAMES[] = { "instance", "enumerate", "device", "compute" };

static void say(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
    fflush(stdout);
}

#define CHECK(call) do { VkResult r_ = (call); if (r_ != VK_SUCCESS) { \
    say("FAIL %s = %d", #call, (int)r_); CRUMB("probe: FAIL %s = %d", #call, (int)r_); return 1; } } while (0)

static void begin(int s) { CRUMB("probe: stage %s begins", NAMES[s]); say("stage %s ...", NAMES[s]); }
static int end(int s) { CRUMB("probe: stage %s done", NAMES[s]); say("stage %s: ok", NAMES[s]); return s >= stop_after; }

static int compute(VkPhysicalDevice pd, VkDevice dev, VkQueue q, uint32_t family) {
    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(pd, &mp);
    VkBufferCreateInfo bi = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, 0, 0, COUNT * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, VK_SHARING_MODE_EXCLUSIVE, 0, 0 };
    VkBuffer buf;
    CHECK(vkCreateBuffer(dev, &bi, 0, &buf));
    VkMemoryRequirements mr;
    vkGetBufferMemoryRequirements(dev, buf, &mr);
    uint32_t want = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, type = UINT32_MAX;
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
        if ((mr.memoryTypeBits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) { type = i; break; }
    if (type == UINT32_MAX) { say("FAIL no host-visible coherent memory"); return 1; }
    VkMemoryAllocateInfo ai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, 0, mr.size, type };
    VkDeviceMemory mem;
    CHECK(vkAllocateMemory(dev, &ai, 0, &mem));
    CHECK(vkBindBufferMemory(dev, buf, mem, 0));
    uint32_t *v;
    CHECK(vkMapMemory(dev, mem, 0, COUNT * 4, 0, (void **)&v));
    for (uint32_t i = 0; i < COUNT; i++) v[i] = i;

    VkShaderModuleCreateInfo si = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, 0, 0, sizeof compute_spv, compute_spv };
    VkShaderModule sm;
    CHECK(vkCreateShaderModule(dev, &si, 0, &sm));
    VkDescriptorSetLayoutBinding lb = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, 0 };
    VkDescriptorSetLayoutCreateInfo li = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, 0, 0, 1, &lb };
    VkDescriptorSetLayout dsl;
    CHECK(vkCreateDescriptorSetLayout(dev, &li, 0, &dsl));
    VkPipelineLayoutCreateInfo pli = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, 0, 0, 1, &dsl, 0, 0 };
    VkPipelineLayout pl;
    CHECK(vkCreatePipelineLayout(dev, &pli, 0, &pl));
    VkComputePipelineCreateInfo cpi = { VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, 0, 0,
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, 0, 0, VK_SHADER_STAGE_COMPUTE_BIT, sm, "main", 0 }, pl, 0, -1 };
    VkPipeline pipe;
    CRUMB("probe: compiling the compute shader");
    CHECK(vkCreateComputePipelines(dev, 0, 1, &cpi, 0, &pipe));
    VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 };
    VkDescriptorPoolCreateInfo dpi = { VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, 0, 0, 1, 1, &ps };
    VkDescriptorPool dp;
    CHECK(vkCreateDescriptorPool(dev, &dpi, 0, &dp));
    VkDescriptorSetAllocateInfo dai = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, 0, dp, 1, &dsl };
    VkDescriptorSet ds;
    CHECK(vkAllocateDescriptorSets(dev, &dai, &ds));
    VkDescriptorBufferInfo dbi = { buf, 0, VK_WHOLE_SIZE };
    VkWriteDescriptorSet w = { VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, 0, ds, 0, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 0, &dbi, 0 };
    vkUpdateDescriptorSets(dev, 1, &w, 0, 0);

    VkCommandPoolCreateInfo cpci = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, 0, 0, family };
    VkCommandPool cp;
    CHECK(vkCreateCommandPool(dev, &cpci, 0, &cp));
    VkCommandBufferAllocateInfo cbai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, 0, cp, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    VkCommandBuffer cb;
    CHECK(vkAllocateCommandBuffers(dev, &cbai, &cb));
    VkCommandBufferBeginInfo cbbi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, 0, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, 0 };
    CHECK(vkBeginCommandBuffer(cb, &cbbi));
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &ds, 0, 0);
    vkCmdDispatch(cb, COUNT / 64, 1, 1);
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, 0, VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_HOST_READ_BIT };
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &mb, 0, 0, 0, 0);
    CHECK(vkEndCommandBuffer(cb));
    VkFenceCreateInfo fi = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, 0, 0 };
    VkFence f;
    CHECK(vkCreateFence(dev, &fi, 0, &f));
    VkSubmitInfo sub = { VK_STRUCTURE_TYPE_SUBMIT_INFO, 0, 0, 0, 0, 1, &cb, 0, 0 };
    CRUMB("probe: submitting");
    CHECK(vkQueueSubmit(q, 1, &sub, f));
    CRUMB("probe: waiting (5 s at most)");
    CHECK(vkWaitForFences(dev, 1, &f, VK_TRUE, 5000000000ull));

    int right = 0, unchanged = 0;
    for (uint32_t i = 0; i < COUNT; i++) { right += v[i] == i * 3 + 7; unchanged += v[i] == i; }
    say("compute: %d of %d right, %d unchanged", right, COUNT, unchanged);
    CRUMB("probe: compute %d right, %d unchanged", right, unchanged);
    int ok = right == COUNT || (unchanged == COUNT && getenv("INTEL_STUB_GPU_PLATFORM"));
    if (right != COUNT && ok) say("compute: not run (the bench's stub GPU runs nothing): accepted on the bench only");

    vkDestroyFence(dev, f, 0);
    vkDestroyCommandPool(dev, cp, 0);
    vkDestroyDescriptorPool(dev, dp, 0);
    vkDestroyPipeline(dev, pipe, 0);
    vkDestroyPipelineLayout(dev, pl, 0);
    vkDestroyDescriptorSetLayout(dev, dsl, 0);
    vkDestroyShaderModule(dev, sm, 0);
    vkUnmapMemory(dev, mem);
    vkFreeMemory(dev, mem, 0);
    vkDestroyBuffer(dev, buf, 0);
    return ok ? 0 : 1;
}

int main(int argc, char **argv) {
    crumb_fn = (void (*)(const char *, ...))dlsym(RTLD_DEFAULT, "vk_crumb");
    stop_after = -1;
    for (int i = 0; argc > 1 && i < 4; i++) if (!strcmp(argv[1], NAMES[i])) stop_after = i;
    if (stop_after < 0) { fprintf(stderr, "usage: vkprobe instance|enumerate|device|compute\n"); return 2; }
    setvbuf(stdout, 0, _IOLBF, 0);

    begin(0);
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, 0, "vkprobe", 1, 0, 0, VK_API_VERSION_1_0 };
    VkInstanceCreateInfo ici = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, 0, 0, &app, 0, 0, 0, 0 };
    VkInstance inst;
    CHECK(vkCreateInstance(&ici, 0, &inst));
    uint32_t ne = 0;
    vkEnumerateInstanceExtensionProperties(0, &ne, 0);
    say("instance: %u extensions offered (none enabled)", ne);
    int rc = 0;
    if (end(0)) goto out_inst;

    begin(1);
    uint32_t n = 0;
    CHECK(vkEnumeratePhysicalDevices(inst, &n, 0));
    if (!n) { say("FAIL no physical device"); rc = 1; goto out_inst; }
    VkPhysicalDevice pds[4];
    if (n > 4) n = 4;
    CHECK(vkEnumeratePhysicalDevices(inst, &n, pds));
    VkPhysicalDevice pd = pds[0];
    VkPhysicalDeviceProperties p;
    vkGetPhysicalDeviceProperties(pd, &p);
    say("device: %s, Vulkan %u.%u.%u, driver %u.%u.%u, %04x:%04x", p.deviceName,
        VK_VERSION_MAJOR(p.apiVersion), VK_VERSION_MINOR(p.apiVersion), VK_VERSION_PATCH(p.apiVersion),
        VK_VERSION_MAJOR(p.driverVersion), VK_VERSION_MINOR(p.driverVersion), VK_VERSION_PATCH(p.driverVersion),
        p.vendorID, p.deviceID);
    uint32_t nq = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(pd, &nq, 0);
    VkQueueFamilyProperties qf[8];
    if (nq > 8) nq = 8;
    vkGetPhysicalDeviceQueueFamilyProperties(pd, &nq, qf);
    uint32_t family = UINT32_MAX;
    for (uint32_t i = 0; i < nq; i++) if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { family = i; break; }
    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(pd, &mp);
    say("queues: %u families, compute in %d; memory: %u heaps, heap 0 %llu MB", nq, (int)family, mp.memoryHeapCount,
        (unsigned long long)(mp.memoryHeaps[0].size >> 20));
    if (family == UINT32_MAX) { say("FAIL no compute queue"); rc = 1; goto out_inst; }
    if (end(1)) goto out_inst;

    begin(2);
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, 0, 0, family, 1, &prio };
    VkDeviceCreateInfo dci = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, 0, 0, 1, &qci, 0, 0, 0, 0, 0 };
    VkDevice dev;
    CHECK(vkCreateDevice(pd, &dci, 0, &dev));
    VkQueue q;
    vkGetDeviceQueue(dev, family, 0, &q);
    CHECK(vkDeviceWaitIdle(dev));
    if (end(2)) goto out_dev;

    begin(3);
    rc = compute(pd, dev, q, family);
    if (!rc) end(3);
out_dev:
    vkDestroyDevice(dev, 0);
out_inst:
    vkDestroyInstance(inst, 0);
    CRUMB("probe: done, %d", rc);
    say("probe: %s", rc ? "failed" : "done");
    return rc;
}
