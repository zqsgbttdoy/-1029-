package com.supervision;

import com.supervision.dto.ApproveDTO;
import com.supervision.dto.SupervisionLogDTO;
import com.supervision.entity.SupervisionLog;
import com.supervision.exception.BusinessException;
import com.supervision.repository.SupervisionLogRepository;
import com.supervision.service.SupervisionLogService;
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
@DisplayName("SupervisionLogService 单元测试")
class SupervisionLogServiceTest {

    @Mock
    private SupervisionLogRepository supervisionLogRepository;

    @InjectMocks
    private SupervisionLogService supervisionLogService;

    private SupervisionLogDTO buildDTO() {
        SupervisionLogDTO dto = new SupervisionLogDTO();
        dto.setCode("JL-ZR-20240101");
        dto.setProjectId(1L);
        dto.setLogDate(LocalDate.of(2024, 1, 1));
        dto.setWeekStart(LocalDate.of(2024, 1, 1));
        dto.setWeekEnd(LocalDate.of(2024, 1, 7));
        dto.setAuthorId(1L);
        dto.setParticipants("[1,2]");
        dto.setWeather("晴");
        dto.setWind("微风");
        dto.setTemperature("25℃");
        dto.setContent("监理日志内容");
        dto.setManagement("管理情况");
        dto.setInspection("检查情况");
        return dto;
    }

    private SupervisionLog buildExisting() {
        SupervisionLog log = new SupervisionLog();
        log.setId(1L);
        log.setCode("JL-ZR-20240101");
        log.setProjectId(1L);
        log.setLogDate(LocalDate.of(2024, 1, 1));
        log.setWeekStart(LocalDate.of(2024, 1, 1));
        log.setWeekEnd(LocalDate.of(2024, 1, 7));
        log.setAuthorId(1L);
        log.setParticipants("[1,2]");
        log.setWeather("晴");
        log.setWind("微风");
        log.setTemperature("25℃");
        log.setContent("监理日志内容");
        log.setManagement("管理情况");
        log.setInspection("检查情况");
        log.setStatus("draft");
        log.setVersion(1);
        return log;
    }

    @Test
    @DisplayName("创建监理日志 - 验证默认status=draft和version=1")
    void testCreateSupervisionLog() {
        SupervisionLogDTO dto = buildDTO();
        when(supervisionLogRepository.findByCode(dto.getCode())).thenReturn(Optional.empty());
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> {
            SupervisionLog log = invocation.getArgument(0);
            log.setId(1L);
            return log;
        });

        SupervisionLog result = supervisionLogService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
        assertEquals(1, result.getVersion());
        assertEquals("JL-ZR-20240101", result.getCode());
        assertEquals(LocalDate.of(2024, 1, 1), result.getWeekStart());
        assertEquals(LocalDate.of(2024, 1, 7), result.getWeekEnd());
        assertEquals("[1,2]", result.getParticipants());
        verify(supervisionLogRepository).save(any(SupervisionLog.class));
    }

    @Test
    @DisplayName("创建监理日志 - 编号已存在应抛出BusinessException")
    void testCreateWithDuplicateCode() {
        SupervisionLogDTO dto = buildDTO();
        SupervisionLog existing = buildExisting();
        when(supervisionLogRepository.findByCode(dto.getCode())).thenReturn(Optional.of(existing));

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionLogService.create(dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(supervisionLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("创建监理日志 - 编号存在但status为inactive时允许创建")
    void testCreateWithInactiveCode() {
        SupervisionLogDTO dto = buildDTO();
        SupervisionLog inactiveLog = buildExisting();
        inactiveLog.setStatus("inactive");
        when(supervisionLogRepository.findByCode(dto.getCode())).thenReturn(Optional.of(inactiveLog));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> {
            SupervisionLog log = invocation.getArgument(0);
            log.setId(2L);
            return log;
        });

        SupervisionLog result = supervisionLogService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
    }

    @Test
    @DisplayName("审核通过 - 验证status=approved")
    void testApproveSupervisionLog() {
        SupervisionLog log = buildExisting();
        log.setRejectReason("之前驳回原因");
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("approved");

        SupervisionLog result = supervisionLogService.approve(dto);

        assertEquals("approved", result.getStatus());
        assertNull(result.getRejectReason());
        verify(supervisionLogRepository).save(any(SupervisionLog.class));
    }

    @Test
    @DisplayName("审核驳回 - 验证status=rejected和rejectReason")
    void testRejectSupervisionLog() {
        SupervisionLog log = buildExisting();
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("rejected");
        dto.setRejectReason("内容不完整");

        SupervisionLog result = supervisionLogService.approve(dto);

        assertEquals("rejected", result.getStatus());
        assertEquals("内容不完整", result.getRejectReason());
        verify(supervisionLogRepository).save(any(SupervisionLog.class));
    }

    @Test
    @DisplayName("删除监理日志 - 应设置status为inactive")
    void testDeleteSupervisionLog() {
        SupervisionLog log = buildExisting();
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        supervisionLogService.delete(1L);

        verify(supervisionLogRepository).save(argThat(l -> "inactive".equals(l.getStatus())));
    }

    @Test
    @DisplayName("根据ID查询 - 监理日志不存在应抛出BusinessException")
    void testGetByIdNotFound() {
        when(supervisionLogRepository.findById(999L)).thenReturn(Optional.empty());

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionLogService.getById(999L));
        assertEquals("监理日志不存在", exception.getMessage());
    }

    @Test
    @DisplayName("新建版本 - 验证version递增")
    void testNewVersion() {
        SupervisionLog existing = buildExisting();
        existing.setVersion(2);
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> {
            SupervisionLog newVer = invocation.getArgument(0);
            newVer.setId(2L);
            return newVer;
        });

        SupervisionLog result = supervisionLogService.newVersion(1L);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
        assertEquals(3, result.getVersion());
        assertEquals(existing.getCode(), result.getCode());
        assertEquals(existing.getProjectId(), result.getProjectId());
        assertEquals(existing.getWeather(), result.getWeather());
        assertEquals(existing.getWeekStart(), result.getWeekStart());
        assertEquals(existing.getWeekEnd(), result.getWeekEnd());
        assertEquals(existing.getParticipants(), result.getParticipants());
        verify(supervisionLogRepository).save(any(SupervisionLog.class));
    }

    @Test
    @DisplayName("更新监理日志 - 正常更新")
    void testUpdateSupervisionLog() {
        SupervisionLog existing = buildExisting();
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SupervisionLogDTO dto = buildDTO();
        dto.setContent("更新后的内容");
        dto.setWeather("雨");

        SupervisionLog result = supervisionLogService.update(1L, dto);

        assertEquals("更新后的内容", result.getContent());
        assertEquals("雨", result.getWeather());
        assertEquals("[1,2]", result.getParticipants());
        verify(supervisionLogRepository).save(any(SupervisionLog.class));
    }

    @Test
    @DisplayName("更新监理日志 - ID不存在应抛出BusinessException")
    void testUpdateNonExistent() {
        when(supervisionLogRepository.findById(999L)).thenReturn(Optional.empty());

        SupervisionLogDTO dto = buildDTO();
        assertThrows(BusinessException.class, () -> supervisionLogService.update(999L, dto));
        verify(supervisionLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("审核 - status为null时应抛出BusinessException")
    void testApproveWithNullStatus() {
        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus(null);

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionLogService.approve(dto));
        assertEquals("审核状态不能为空", exception.getMessage());
        verify(supervisionLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("审核 - approved状态不可再次审批应抛出BusinessException")
    void testApproveAlreadyApproved() {
        SupervisionLog log = buildExisting();
        log.setStatus("approved");
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(log));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("approved");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionLogService.approve(dto));
        assertEquals("只有草稿或已提交状态的日志才能审批", exception.getMessage());
        verify(supervisionLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("审核 - submitted状态可审批通过")
    void testApproveSubmittedLog() {
        SupervisionLog log = buildExisting();
        log.setStatus("submitted");
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(log));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ApproveDTO dto = new ApproveDTO();
        dto.setId(1L);
        dto.setStatus("approved");

        SupervisionLog result = supervisionLogService.approve(dto);

        assertEquals("approved", result.getStatus());
        verify(supervisionLogRepository).save(any());
    }

    @Test
    @DisplayName("更新监理日志 - 新code已被其他active记录占用应抛出BusinessException")
    void testUpdateWithDuplicateCode() {
        SupervisionLog existing = buildExisting();
        SupervisionLog otherRecord = buildExisting();
        otherRecord.setId(2L);
        otherRecord.setCode("JL-ZR-OTHER");
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionLogRepository.findByCode("JL-ZR-OTHER")).thenReturn(Optional.of(otherRecord));

        SupervisionLogDTO dto = buildDTO();
        dto.setCode("JL-ZR-OTHER");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionLogService.update(1L, dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(supervisionLogRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新监理日志 - 新code仅被inactive记录占用时允许更新")
    void testUpdateWithInactiveDuplicateCode() {
        SupervisionLog existing = buildExisting();
        SupervisionLog inactiveRecord = buildExisting();
        inactiveRecord.setId(2L);
        inactiveRecord.setCode("JL-ZR-OTHER");
        inactiveRecord.setStatus("inactive");
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionLogRepository.findByCode("JL-ZR-OTHER")).thenReturn(Optional.of(inactiveRecord));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SupervisionLogDTO dto = buildDTO();
        dto.setCode("JL-ZR-OTHER");

        SupervisionLog result = supervisionLogService.update(1L, dto);

        assertEquals("JL-ZR-OTHER", result.getCode());
        verify(supervisionLogRepository).save(any());
    }

    @Test
    @DisplayName("更新监理日志 - 新code与自身原code相同允许更新")
    void testUpdateWithSameCode() {
        SupervisionLog existing = buildExisting();
        when(supervisionLogRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionLogRepository.save(any(SupervisionLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SupervisionLogDTO dto = buildDTO();
        dto.setContent("新内容");

        SupervisionLog result = supervisionLogService.update(1L, dto);

        assertEquals("新内容", result.getContent());
        verify(supervisionLogRepository).save(any());
        verify(supervisionLogRepository, never()).findByCode(any());
    }
}