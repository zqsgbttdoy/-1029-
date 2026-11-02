package com.supervision;

import com.supervision.dto.ApproveDTO;
import com.supervision.dto.SafetyLogDTO;
import com.supervision.entity.SafetyLog;
import com.supervision.exception.BusinessException;
import com.supervision.repository.SafetyLogRepository;
import com.supervision.service.SafetyLogService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDate;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@DisplayName("SafetyLogService 单元测试")
class SafetyLogServiceTest {

    @Mock
    private SafetyLogRepository safetyLogRepository;

    @Mock private com.supervision.service.ProjectAccessService access;
    @Mock private com.supervision.service.AttachmentAccessService attachmentAccess;
    @Mock private jakarta.persistence.EntityManager em;

    @org.junit.jupiter.api.BeforeEach
    void identity() {
        var user = new com.supervision.entity.User();
        user.setId(1L);
        lenient().when(access.currentUser()).thenReturn(user);
    }

    @InjectMocks
    private SafetyLogService safetyLogService;

    @Test
    void deniedProjectCannotCreate() {
        doThrow(new BusinessException(403, "无项目权限")).when(access).requireRead(1L);
        assertThrows(BusinessException.class, () -> safetyLogService.create(buildDTO()));
        verifyNoInteractions(safetyLogRepository, attachmentAccess);
    }

    private SafetyLogDTO buildDTO() {
        SafetyLogDTO dto = new SafetyLogDTO();
        dto.setCode("AQ-20240101");
        dto.setProjectId(1L);
        dto.setLogDate(LocalDate.of(2024, 1, 1));
        dto.setAuthorId(1L);
        dto.setWeather("晴");
        dto.setWind("微风");
        dto.setTemperature("25℃");
        dto.setContent("安全日志内容");
        dto.setInspection("检查情况");
        dto.setSafety("安全措施");
        dto.setMajorIssue("重大安全隐患");
        return dto;
    }

    private SafetyLog buildExisting() {
        SafetyLog log = new SafetyLog();
        log.setId(1L);
        log.setCode("AQ-20240101");
        log.setProjectId(1L);
        log.setLogDate(LocalDate.of(2024, 1, 1));
        log.setAuthorId(1L);
        log.setWeather("晴");
        log.setWind("微风");
        log.setTemperature("25℃");
        log.setContent("安全日志内容");
        log.setInspection("检查情况");
        log.setSafety("安全措施");
        log.setMajorIssue("重大安全隐患");
        log.setStatus("draft");
        log.setVersion(1);
        return log;
    }

    @Test
    @DisplayName("创建安全日志 - 验证默认status=draft和version=1")
    void testCreateSafetyLog() {
        SafetyLogDTO dto = buildDTO();
        when(safetyLogRepository.findByCode(dto.getCode())).thenReturn(Optional.empty());
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> {
            SafetyLog log = invocation.getArgument(0);
            log.setId(1L);
            return log;
        });

        SafetyLog result = safetyLogService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
        assertEquals(1, result.getVersion());
        assertEquals("AQ-20240101", result.getCode());
        assertEquals("晴", result.getWeather());
        verify(safetyLogRepository).save(any(SafetyLog.class));
    }

    @Test
    @DisplayName("创建安全日志 - 编号已存在应抛出BusinessException")
    void testCreateWithDuplicateCode() {
        SafetyLogDTO dto = buildDTO();
        SafetyLog existing = buildExisting();
        when(safetyLogRepository.findByCode(dto.getCode())).thenReturn(Optional.of(existing));

        BusinessException exception = assertThrows(BusinessException.class,
                () -> safetyLogService.create(dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("创建安全日志 - 编号存在但status为inactive时允许创建")
    void testCreateWithInactiveCode() {
        SafetyLogDTO dto = buildDTO();
        SafetyLog inactiveLog = buildExisting();
        inactiveLog.setStatus("inactive");
        when(safetyLogRepository.findByCode(dto.getCode())).thenReturn(Optional.of(inactiveLog));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> {
            SafetyLog log = invocation.getArgument(0);
            log.setId(2L);
            return log;
        });

        SafetyLog result = safetyLogService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
    }

    @Test
    @DisplayName("审核通过 - 验证status=approved")
    void testApproveSafetyLog() {
        SafetyLog log = buildExisting();
        log.setStatus("submitted"); // 契约修正：仅已提交状态可审批，草稿审批已改为 409
        log.setRejectReason("之前驳回原因");
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("approved");

        SafetyLog result = safetyLogService.approve(dto);

        assertEquals("approved", result.getStatus());
        assertNull(result.getRejectReason());
        verify(safetyLogRepository).save(any(SafetyLog.class));
    }

    @Test
    @DisplayName("审核驳回 - 验证status=rejected和rejectReason")
    void testRejectSafetyLog() {
        SafetyLog log = buildExisting();
        log.setStatus("submitted"); // 契约修正：驳回同样要求已提交状态
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("rejected");
        dto.setRejectReason("安全措施不到位");

        SafetyLog result = safetyLogService.approve(dto);

        assertEquals("rejected", result.getStatus());
        assertEquals("安全措施不到位", result.getRejectReason());
        verify(safetyLogRepository).save(any(SafetyLog.class));
    }

    @Test
    @DisplayName("删除安全日志 - 应设置status为inactive")
    void testDeleteSafetyLog() {
        SafetyLog log = buildExisting();
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        safetyLogService.delete(1L);

        verify(safetyLogRepository).save(argThat(l -> "inactive".equals(l.getStatus())));
    }

    @Test
    @DisplayName("根据ID查询 - 安全日志不存在应抛出BusinessException")
    void testGetByIdNotFound() {
        when(safetyLogRepository.findById(999L)).thenReturn(Optional.empty());

        BusinessException exception = assertThrows(BusinessException.class,
                () -> safetyLogService.getById(999L));
        assertEquals("安全日志不存在", exception.getMessage());
    }

    @Test
    @DisplayName("新建版本 - 验证version递增")
    void testNewVersion() {
        SafetyLog existing = buildExisting();
        existing.setVersion(2);
        existing.setStatus("rejected");
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> {
            SafetyLog newVer = invocation.getArgument(0);
            newVer.setId(2L);
            return newVer;
        });

        SafetyLog result = safetyLogService.newVersion(1L);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
        assertEquals(3, result.getVersion());
        assertNotEquals(existing.getCode(), result.getCode());
        assertEquals(existing.getId(), result.getSourceRecordId());
        assertEquals("rejected", existing.getStatus());
        assertEquals(existing.getProjectId(), result.getProjectId());
        assertEquals(existing.getWeather(), result.getWeather());
        verify(safetyLogRepository).save(any(SafetyLog.class));
    }

    @Test
    void frozenVersionsCannotBeUpdatedOrDeleted() {
        SafetyLog existing = buildExisting();
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        for (String status : java.util.List.of("submitted", "rejected", "approved", "pending")) {
            existing.setStatus(status);
            assertEquals(409, assertThrows(BusinessException.class, () -> safetyLogService.update(1L, buildDTO())).getCode());
            assertEquals(409, assertThrows(BusinessException.class, () -> safetyLogService.delete(1L)).getCode());
            assertEquals("安全日志内容", existing.getContent());
        }
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    void revisionResumesExistingDraftAndRequiresOriginalAuthor() {
        SafetyLog existing = buildExisting(); existing.setStatus("rejected");
        SafetyLog next = buildExisting(); next.setId(2L); next.setVersion(2); next.setSourceRecordId(1L);
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(safetyLogRepository.findFirstBySourceRecordIdAndStatusNotOrderByIdAsc(1L, "inactive")).thenReturn(Optional.of(next));
        assertSame(next, safetyLogService.newVersion(1L));
        existing.setAuthorId(2L);
        assertEquals(403, assertThrows(BusinessException.class, () -> safetyLogService.newVersion(1L)).getCode());
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新安全日志 - 正常更新")
    void testUpdateSafetyLog() {
        SafetyLog existing = buildExisting();
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SafetyLogDTO dto = buildDTO();
        dto.setWeather("雨");
        dto.setContent("更新后的内容");

        SafetyLog result = safetyLogService.update(1L, dto);

        assertEquals("雨", result.getWeather());
        assertEquals("更新后的内容", result.getContent());
        verify(safetyLogRepository).save(any(SafetyLog.class));
    }

    @Test
    @DisplayName("更新安全日志 - ID不存在应抛出BusinessException")
    void testUpdateNonExistent() {
        when(safetyLogRepository.findById(999L)).thenReturn(Optional.empty());

        SafetyLogDTO dto = buildDTO();
        assertThrows(BusinessException.class, () -> safetyLogService.update(999L, dto));
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("审核 - status为null时应抛出BusinessException")
    void testApproveWithNullStatus() {
        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus(null);

        BusinessException exception = assertThrows(BusinessException.class,
                () -> safetyLogService.approve(dto));
        assertEquals("审核状态不能为空", exception.getMessage());
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("审核 - approved状态不可再次审批应抛出BusinessException")
    void testApproveAlreadyApproved() {
        SafetyLog log = buildExisting();
        log.setStatus("approved");
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("approved");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> safetyLogService.approve(dto));
        assertEquals("只有已提交状态的安全日志才能审批", exception.getMessage());
        assertEquals(409, exception.getCode());
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("审核 - 草稿未提交不得审批（409，对应上线契约 qaAcceptanceSafetyDraftCannotBeApproved）")
    void testApproveDraftIsConflict() {
        SafetyLog log = buildExisting(); // 默认 draft
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("approved");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> safetyLogService.approve(dto));
        assertEquals(409, exception.getCode());
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新 - 已批准记录正文不可覆盖（409）")
    void testUpdateApprovedIsImmutable() {
        SafetyLog log = buildExisting();
        log.setStatus("approved");
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));

        SafetyLogDTO dto = buildDTO();
        dto.setContent("不应覆盖已批准正文");

        BusinessException exception = assertThrows(BusinessException.class, () -> safetyLogService.update(1L, dto));
        assertEquals(409, exception.getCode());
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新 - 提交状态应持久化（draft→submitted）")
    void testUpdateStatusSubmittedPersists() {
        SafetyLog log = buildExisting();
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SafetyLogDTO dto = buildDTO();
        dto.setStatus("submitted");

        assertEquals("submitted", safetyLogService.update(1L, dto).getStatus());
    }

    @Test
    @DisplayName("更新 - 审批终态不得通过更新接口直达（400）")
    void testUpdateCannotApproveDirectly() {
        SafetyLog log = buildExisting();
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));

        SafetyLogDTO dto = buildDTO();
        dto.setStatus("approved");

        BusinessException exception = assertThrows(BusinessException.class, () -> safetyLogService.update(1L, dto));
        assertEquals(400, exception.getCode());
    }

    @Test
    @DisplayName("审核 - submitted状态可审批通过")
    void testApproveSubmittedLog() {
        SafetyLog log = buildExisting();
        log.setStatus("submitted");
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("approved");

        SafetyLog result = safetyLogService.approve(dto);

        assertEquals("approved", result.getStatus());
        verify(safetyLogRepository).save(any());
    }

    @Test
    @DisplayName("更新安全日志 - 新code已被其他active记录占用应抛出BusinessException")
    void testUpdateWithDuplicateCode() {
        SafetyLog existing = buildExisting();
        SafetyLog otherRecord = buildExisting();
        otherRecord.setId(2L);
        otherRecord.setCode("AQ-OTHER");
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(safetyLogRepository.findByCode("AQ-OTHER")).thenReturn(Optional.of(otherRecord));

        SafetyLogDTO dto = buildDTO();
        dto.setCode("AQ-OTHER");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> safetyLogService.update(1L, dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(safetyLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新安全日志 - 新code仅被inactive记录占用时允许更新")
    void testUpdateWithInactiveDuplicateCode() {
        SafetyLog existing = buildExisting();
        SafetyLog inactiveRecord = buildExisting();
        inactiveRecord.setId(2L);
        inactiveRecord.setCode("AQ-OTHER");
        inactiveRecord.setStatus("inactive");
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(safetyLogRepository.findByCode("AQ-OTHER")).thenReturn(Optional.of(inactiveRecord));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SafetyLogDTO dto = buildDTO();
        dto.setCode("AQ-OTHER");

        SafetyLog result = safetyLogService.update(1L, dto);

        assertEquals("AQ-OTHER", result.getCode());
        verify(safetyLogRepository).save(any());
    }

    @Test
    @DisplayName("更新安全日志 - 新code与自身原code相同允许更新")
    void testUpdateWithSameCode() {
        SafetyLog existing = buildExisting();
        when(safetyLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(safetyLogRepository.save(any(SafetyLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SafetyLogDTO dto = buildDTO();
        dto.setWeather("雨");

        SafetyLog result = safetyLogService.update(1L, dto);

        assertEquals("雨", result.getWeather());
        verify(safetyLogRepository).save(any());
        verify(safetyLogRepository, never()).findByCode(any());
    }
}